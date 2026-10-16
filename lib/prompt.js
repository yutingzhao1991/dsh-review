/**
 * 提示词组装。
 *
 * 一份评审请求拆成两半：`system`（评审者身份与模式的强度要求）和 `body`
 * （这次要评什么、材料是什么、按什么格式回答）。LLM / 子智能体评审者分别放进
 * system 槽与 user 消息；CLI 评审者只能收一段文本，于是拼起来给。
 */

import { modePrompt } from './settings.js';

const PERSONA = {
	zh: [
		'你是一名严格、务实的资深代码评审者。',
		'你只依据下面给出的材料评审；材料没覆盖的代码不要臆测，需要时可以说明「材料不足」。',
		'每条问题都要给出：严重级别（P0 阻断 / P1 严重 / P2 一般 / P3 建议）、位置（文件:行）、问题本身、为什么是问题、最小修复建议。',
		'不要复述 diff，不要写客套话，不要为了凑数报告风格偏好。',
		'如果确实没有真问题，明确写「未发现需要修复的问题」，并列出你检查过的方面。',
	].join('\n'),
	en: [
		'You are a strict, pragmatic senior code reviewer.',
		'Review only the material given below; do not speculate about code you cannot see — say "insufficient material" when it matters.',
		'For every finding give: severity (P0 blocker / P1 major / P2 minor / P3 nit), location (file:line), the problem, why it is a problem, and the smallest fix.',
		'Do not restate the diff, do not add pleasantries, and do not pad the list with style preferences.',
		'If there is genuinely nothing to fix, say so explicitly and list what you checked.',
	].join('\n'),
};

const OUTPUT_FORMAT = {
	zh: [
		'### 输出格式',
		'1. 一句话结论。',
		'2. `## 问题`：按严重级别从高到低排列，每条一行 —— `[P1] 文件:行 — 问题 — 修复建议`。',
		'3. `## 检查过但没问题的方面`（可选，一行一条）。',
	].join('\n'),
	en: [
		'### Output format',
		'1. One-sentence verdict.',
		'2. `## Findings`: highest severity first, one line each — `[P1] file:line — problem — fix`.',
		'3. `## Checked, no issue` (optional, one line each).',
	].join('\n'),
};

const LANGUAGE_LINE = {
	zh: '输出语言：中文。',
	en: 'Output language: English.',
	auto: '输出语言：与下方「附加指令」一致；没有附加指令时用中文。',
};

/** 有效语言（`auto` 交给模型按附加指令判断，提示词里仍然要写清楚规则）。 */
function languageKey(settings) {
	return settings.language === 'en' ? 'en' : 'zh';
}

/** 模式的 when 策略文本；没有 when 就返回 undefined（默认「不做任何设置」）。 */
export function buildPolicyText(settings) {
	const modes = Object.values(settings.modes).filter((mode) => mode.when !== undefined);
	const defaultMode = settings.defaultMode === undefined ? undefined : settings.modes[settings.defaultMode];
	if (modes.length === 0 && defaultMode?.when === undefined) return undefined;

	const lines = ['## 代码评审要求'];
	if (defaultMode?.when !== undefined) {
		lines.push(`默认模式：\`${defaultMode.name}\`${defaultMode.description === undefined ? '' : `（${defaultMode.description}）`}`);
	}
	for (const mode of modes) {
		const threshold = mode.minChangedLines === undefined ? '' : `（改动超过 ${mode.minChangedLines} 行时）`;
		if (mode.when === 'always') {
			lines.push(`- 模式 \`${mode.name}\`：**任何改动都必须经过 review 工具评审**，在宣布任务完成之前调用。`);
		} else if (mode.when === 'complex') {
			lines.push(
				`- 模式 \`${mode.name}\`：只要求**复杂改动**经过 review${threshold}——涉及并发、错误处理、安全、数据迁移、公开接口、构建配置，或改动大到一个提交说不清。琐碎改动（文案、注释、格式）不必。`,
			);
		} else if (mode.when === 'never') {
			lines.push(`- 模式 \`${mode.name}\`：本模式不强制评审，由调用方自行判断。`);
		}
	}
	lines.push('- 调用方式：`review` 工具（可选 `mode`、`reviewers`、`base`/`commit`/`instructions`）。', '- 评审意见是建议而不是命令：采纳与否要自己判断，并在回复里说明处理结果。');
	return lines.join('\n');
}

/** 交付给 codex 原生 review 的 PROMPT（只有它能收 PROMPT；范围开关与 PROMPT 互斥）。 */
export function buildNativePrompt(mode, target) {
	const parts = [];
	const modeText = modePrompt(mode);
	if (modeText !== undefined) parts.push(modeText);
	const instructions = typeof target?.instructions === 'string' ? target.instructions.trim() : '';
	if (instructions.length > 0) parts.push(instructions);
	return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/** 范围 + 统计 + 模式 + 附加指令 + 材料 + 输出格式。 */
export function buildBrief({ settings, mode, target, changes, extraNotes }) {
	const lang = languageKey(settings);
	const modeText = modePrompt(mode);

	const systemParts = [PERSONA[lang], LANGUAGE_LINE[settings.language] ?? LANGUAGE_LINE.auto];
	if (modeText !== undefined) systemParts.push(`### 本次评审强度\n\n${modeText}`);

	const bodyParts = [];
	const scopeLines = [`- 评审范围：${describeScope(target)}`];
	if (changes !== undefined && changes.summary.files > 0) {
		scopeLines.push(`- 变更规模：${changes.summary.files} 个文件，+${changes.summary.additions} / -${changes.summary.deletions}`);
	} else if (changes !== undefined) {
		scopeLines.push('- 变更规模：未检测到改动');
	}
	if (mode !== undefined) scopeLines.push(`- 评审模式：\`${mode.name}\`（${mode.strength}）`);
	const instructions = typeof target?.instructions === 'string' ? target.instructions.trim() : '';
	if (instructions.length > 0) scopeLines.push(`\n**附加指令（优先级最高，冲突时以它为准）**：\n\n${instructions}`);
	bodyParts.push(`## 评审任务\n\n${scopeLines.join('\n')}`);

	if (changes?.packet !== undefined && changes.packet.text.trim().length > 0) {
		bodyParts.push(`## 变更内容\n\n${changes.packet.text}`);
	}

	if (Array.isArray(extraNotes) && extraNotes.length > 0) {
		bodyParts.push(`## 材料说明\n\n${extraNotes.map((note) => `- ${note}`).join('\n')}`);
	}

	bodyParts.push(OUTPUT_FORMAT[lang]);

	return { system: systemParts.join('\n\n'), body: bodyParts.join('\n\n') };
}

function describeScope(target) {
	const base = typeof target?.base === 'string' ? target.base.trim() : '';
	const commit = typeof target?.commit === 'string' ? target.commit.trim() : '';
	if (base.length > 0) return `工作区相对 \`${base}\` 的全部改动（含未提交）`;
	if (commit.length > 0) return `提交 \`${commit}\` 引入的改动`;
	return '未提交的改动（staged + unstaged + 未跟踪新文件）';
}

/** CLI 评审者只能收一段文本，把两半拼起来。 */
export function flattenBrief(brief) {
	return `${brief.system}\n\n----- \n\n${brief.body}`;
}
