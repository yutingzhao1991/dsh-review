/**
 * dsh-review —— DSH Host 插件：给智能体一个通用的 `review` 工具。
 *
 * 一个工具，两种评审者（都是具备完整智能体能力的执行体）：
 *
 * - `cli`：codex / claude / gemini / cursor-agent / 自定义 argv 模板。进程由宿主侧
 *   `ctx.subprocess` 直接起，不走 bash 工具，所以不受 DSH 文件沙箱与命令审批影响
 *   （codex 需要读写 `~/.codex`，在沙箱下会直接 `Operation not permitted`，走审批
 *   又会让每次评审都卡一次）。
 * - `subagent`：`ctx.subagents` 起一个子智能体，可以自己翻仓库；模型来自 DSH 自己的
 *   provider 配置。递归由宿主的委派深度预算兜底（默认 1），persona 与工具集由 Agent
 *   Preset 组合（`agentPreset`）。
 *
 * 刻意**没有**「把 diff 丢给一个裸模型」这一类：能自己打开仓库的评审者更有价值。
 * 两者都收敛成同一份报告，由 `mode` 控制强度与提示词；`config` 决定暴露哪些评审者。
 *
 * 执行放进 `ctx.jobs` 后台注册表（与 bash 后台命令同一套机制）：工具会等一小段
 * 时间，跑完就地返回结论，没跑完就交回 job id，之后由模型用 `job_output` 收结果、
 * `job_kill` 终止，结束时注册表会自动通知发起会话。
 */

import { statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertRevisionExists, collectChanges, describeCall, describeTarget } from './lib/changes.js';
import { buildBrief, buildNativePrompt, buildPolicyText, flattenBrief } from './lib/prompt.js';
import { composeReport, truncateText } from './lib/report.js';
import { checkCliVersion, clampForArgv, probeCliReviewer, reviewerEnv, runReviewer } from './lib/reviewers.js';
import { Config, schemaAvailable, schemaSource, unwrapConfig } from './lib/schema.js';
import { modePrompt, needsPacket, resolveMode, resolveSettings, selectReviewers } from './lib/settings.js';
import { createReviewStatusProjection } from './lib/status.js';

/** 加载器诊断用的插件名；`cordis.patch.yml` 里的 id 是 `review`。 */
export const name = 'review';

/**
 * GUI 表单的宿主半边：`dsh-settings` 只把 Config schema 里标了 `.volatile()` 的字段
 * 投影成设置页表单，写到 profile patch 层并立即生效。拿不到 schemastery 时这里是
 * undefined —— 插件照常工作，只是 GUI 里没有表单（工具描述会说明）。
 */
export { Config };

/** 仅供自测：把心跳间隔调小，避免用例等 30 秒。 */
export const __internals = { heartbeatMs: 30_000, writeReport: writeFile };

/**
 * 硬依赖：缺任何一个都说明这套组合跑不了这个工具，直接不激活而不是半残。
 *
 * `sessionProjections` 是对话与输入框之间「评审状态」的数据源：host 把 review job 的生命周期
 * 折成一份随会话持久化的快照，client 只读整值。它由 DSH base 提供（0.2.1 起），
 * 和 tools / jobs 同属运行这套插件的前提。
 */
export const inject = ['tools', 'subprocess', 'jobs', 'sessionProjections'];

const OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		kind: { type: 'string', enum: ['completed', 'running'] },
		jobId: { type: 'string' },
		status: { type: 'string' },
		detail: { type: 'string' },
		reviewers: { type: 'array', items: { type: 'string' } },
		report: { type: 'string' },
	},
	required: ['kind', 'report'],
};

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** 配置里的 id 可能带 `/`（`bailian/qwen`），落盘文件名要洗一遍；序号保证唯一。 */
function safeFileName(id, index) {
	const cleaned = String(id).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'reviewer';
	return `${index}-${cleaned}`;
}

/* ────────────────────────────── 工具元信息 ────────────────────────────── */

/**
 * 只对**含 `/` 的** `executable` 做同步存在性检查。
 *
 * 配置解析保持纯粹：不去 stat PATH 上的裸名字（否则 `codex` 会被当成「当前目录下的文件
 * 不存在」而误报）。这里挡的是一类确定的问题——patch 里钉死的绝对路径已经不在了：
 * 本机事故就是依赖重装删掉了那个文件，而工具描述仍宣告「可用评审者」，模型照着调用一路白跑。
 */
function missingExecutableNote(reviewer) {
	if (reviewer.kind !== 'cli') return '';
	const executable = reviewer.executable;
	if (typeof executable !== 'string' || !executable.includes('/')) return '';
	try {
		return statSync(executable).isFile() ? '' : '（⚠️ 不是普通文件，调用会失败）';
	} catch {
		return '（⚠️ 可执行文件不存在，调用会失败）';
	}
}

/** 工具描述从配置生成：模型能直接看到「有哪些评审者、哪些模式」。 */
function buildToolDescription(settings) {
	const lines = ['用外部评审者评审代码改动，返回它们的评审结论（findings、风险、建议）。', ''];

	const enabled = settings.reviewers.filter((reviewer) => reviewer.enabled);
	// 这份描述是注册时生成的；宿主不会因为 patch 变化重载插件代码，所以必须把
	// “快照”写在清单旁边——否则模型会把“当时没有”当成“现在没有”，直接跳过评审。
	lines.push('可用评审者（**注册时快照**；配置改动后可能过期，准确清单以 `review({ doctor: true })` 为准）：');
	if (enabled.length === 0) {
		lines.push('- （快照里没有启用的评审者。这不等于现在没有——先跑 `review({ doctor: true })` 确认，再决定是否跳过评审。）');
	} else {
		for (const reviewer of enabled) {
			const target = reviewer.kind === 'cli' ? `可执行 ${reviewer.executable}` : `子智能体 ${reviewer.provider}`;
			lines.push(`- \`${reviewer.id}\`（${reviewer.kind}，${reviewer.label}）：${target}${missingExecutableNote(reviewer)}`);
		}
	}

	const modes = Object.values(settings.modes);
	if (modes.length > 0) {
		lines.push('', `评审模式（可选 \`mode\` 参数，默认 ${settings.defaultMode === undefined ? '不套模式' : `\`${settings.defaultMode}\``}）：`);
		for (const mode of modes) {
			const bits = [mode.strength];
			if (mode.reviewers !== undefined) bits.push(`评审者 ${mode.reviewers.join('/')}`);
			lines.push(`- \`${mode.name}\`（${bits.join('，')}）${mode.description === undefined ? '' : `：${mode.description}`}`);
		}
	} else {
		lines.push('', '没有配置评审模式：插件不追加任何评审强度或提示词约束，由调用方自己用 instructions 说明关注点。');
	}

	if (settings.warnings.length > 0) {
		lines.push('', '⚠️ 配置告警（部分配置被忽略）：', ...settings.warnings.map((warning) => `- ${warning}`));
	}

	lines.push(
		'',
		schemaAvailable ? '配置也可以在 GUI 里改：侧边栏 Plugins → dsh-review 的行/包页面（解析与保存都由宿主负责）。' : 'GUI 表单在本部署不可用（找不到 @deepseek-ai/schemastery），配置请改 profile 的 cordis.patch.yml。',
		'不传参数时评审工作区里 staged / unstaged / untracked 的全部改动。',
		'参数规则：`base` 与 `commit` **互斥**，只能给一个。`base`/`commit` 可以和 `instructions` 同时给——只要选中的评审者里有能同时收「范围 + 关注点」的（subagent 类都可以）；全是「PROMPT 与范围开关互斥」的 CLI 时会被直接拒绝（二者只能留一个，或加一个 subagent 评审者；写进 `mode` 的提示词同样会被跳过）。同时给时，收不了 instructions 的评审者只收范围（范围优先），报告脚注会点名是谁没收到。',
		'`reviewers` 只能从运行期启用的评审者里选，写别的 id 会直接报错（插件没有「按需指名模型」这条路）；上面清单只是注册时快照。',
		'单次评审不一定穷尽（同一份改动，各评审者可能各有遗漏）：要覆盖度就用 `mode` 的深度模式，或者一次多选几个评审者。',
		'评审通常要跑几分钟：默认**立即**返回 job id（不等待），用 job_output 读结果，跑完会自动通知；调用方可自行决定什么时候放弃。',
		'评审者要是总是失败（换了机器、重装过依赖），先用 `doctor: true` 做一次环境自检（不评审任何改动）。',
	);
	return lines.join('\n');
}

function buildParameters(settings) {
	const enabled = settings.reviewers.filter((reviewer) => reviewer.enabled);
	const reviewersHint =
		settings.defaultReviewers !== undefined && settings.defaultReviewers.length > 0
			? `不传则用默认集合：${settings.defaultReviewers.join(', ')}。`
			: enabled.length > 0
				? '不传则用 defaultReviewers；一个都没启用时调用会直接报错。'
				: '当前没有配置评审者。';
	const modeHint = Object.keys(settings.modes).length > 0 ? `可用：${Object.keys(settings.modes).join(', ')}。不传用默认模式。` : '当前没有配置模式。';
	return {
		type: 'object',
		additionalProperties: false,
		properties: {
			reviewers: {
				type: 'array',
				items: { type: 'string' },
				description: `要使用的评审者 id。注册时快照里启用的有：${enabled.map((reviewer) => reviewer.id).join(', ') || '（当时没有启用的评审者）'}；运行期可能已变，准确清单以 \`doctor: true\` 为准，传错会立刻报错并列出可用项。${reviewersHint}`,
			},
			mode: { type: 'string', description: `评审模式（强度、提示词、评审者集合）。${modeHint}` },
			base: { type: 'string', description: '评审当前工作区相对该分支的改动（如 "main"）。与 commit 互斥，只能给一个；可以和 instructions 同时给（前提见工具描述：需要选中的评审者里有能同时收范围与关注点的）。' },
			commit: { type: 'string', description: '评审该提交引入的改动（commit sha）。与 base 互斥，只能给一个；可以和 instructions 同时给（前提见工具描述）。' },
			instructions: {
				type: 'string',
				description: '附加评审指令，用来聚焦关注点（如「只看并发与错误处理」）。不传 base/commit 时按未提交的改动评审；传了范围时，只有能同时收「范围 + 关注点」的评审者（subagent 类）会收到它，其余只收范围并在报告脚注里被点名；选中的评审者全是 codex 这类「PROMPT 与范围开关互斥」的 CLI 时会直接报错（范围与 instructions 只能留一个）。',
			},
			timeoutMs: {
				type: 'integer',
				description: '本次评审的墙钟上限（毫秒，1..86400000）。不传则用配置里的 `hardTimeoutMs`；两者都设时取较小值。超时后报告会按实际生效的上限归因。',
			},
			doctor: {
				type: 'boolean',
				description: '只做环境自检，不评审任何改动：逐个检查评审者的可执行文件能否定位、`--version` 是否可跑、子智能体的 provider 是否注册。配置疑似有问题（某个评审者总是失败、换了机器/重装过依赖）时先跑它，比发起一次真评审省事得多。',
			},
		},
	};
}

/**
 * 校验模型参数。值只作为独立 argv / 消息正文传递，不存在 shell 拼接；这里挡住的是
 * 无意义的形态。
 *
 * `base`/`commit` 与 `instructions` 的组合限制来自具体评审者的能力：codex 声明 `[PROMPT]`
 * 不能与 `--base`/`--commit` 同时出现（`promptReplacesRange`），而子智能体两者都能收。
 * 所以按**选中的评审者集合**判：只要有能同时收的（子智能体）就放行，收不了的按「范围优先」
 * 丢掉 instructions 并在报告脚注点名；全都被限制才在工具层拒绝（起 job 之前，即时错误）。
 * `base` 与 `commit` 则是无条件互斥——它们描述的是两个互相替代的范围。
 */
function validateArgs(raw) {
	const args = isRecord(raw) ? raw : {};
	const base = typeof args.base === 'string' ? args.base.trim() : '';
	const commit = typeof args.commit === 'string' ? args.commit.trim() : '';
	const instructions = typeof args.instructions === 'string' ? args.instructions.trim() : '';

	if (base.length > 0 && commit.length > 0) {
		throw new Error('base 与 commit 只能给一个：base 评审相对分支的改动，commit 评审某个提交的改动。');
	}
	for (const [label, value] of [['base', base], ['commit', commit]]) {
		if (value.length === 0) continue;
		if (value.length > 200 || /[\0\n\r]/.test(value)) throw new Error(`${label} 取值不合法（最多 200 字符，且不能含换行）。`);
		// argv 直传不经 shell，但 `git diff --cached` 这类值会被 git 当成开关：
		// 范围只能用真正的 revision，不能以 `-` 开头。
		if (value.startsWith('-')) throw new Error(`${label} 不能以 "-" 开头（会被 git 当成选项而不是 revision）。`);
	}
	if (instructions === '-') throw new Error('instructions 不能是 "-"（那是 codex 的「从 stdin 读」约定，本工具不提供 stdin）。');
	if (instructions.length > 8000) throw new Error('instructions 过长：最多 8000 字符。');

	let timeoutMs = 0;
	if (args.timeoutMs !== undefined) {
		if (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0 || args.timeoutMs > 86_400_000) {
			throw new Error('timeoutMs 必须是 1 到 86400000 之间的整数（毫秒）。');
		}
		timeoutMs = args.timeoutMs;
	}

	let reviewers;
	if (args.reviewers !== undefined) {
		if (!Array.isArray(args.reviewers) || args.reviewers.some((entry) => typeof entry !== 'string')) {
			throw new Error('reviewers 必须是字符串数组。');
		}
		reviewers = args.reviewers;
	}
	return { base, commit, instructions, timeoutMs, reviewers, mode: typeof args.mode === 'string' ? args.mode : undefined, doctor: args.doctor === true };
}

/* ────────────────────────────── 环境自检 ────────────────────────────── */

/**
 * 描述指纹：覆盖 `buildToolDescription` / `buildParameters` 的输入里会影响文案的字段。
 *
 * 只比 reviewer id 不够——默认集合、模式、可执行文件、label、warnings 变了，描述同样
 * 会过期。指纹只用于 doctor 的“是否一致”判断，不参与执行。
 */
function descriptionFingerprint(settings) {
	return JSON.stringify({
		reviewers: settings.reviewers
			.filter((reviewer) => reviewer.enabled)
			.map((reviewer) => ({
				id: reviewer.id,
				kind: reviewer.kind,
				label: reviewer.label,
				executable: reviewer.executable ?? null,
				provider: reviewer.provider ?? null,
				preset: reviewer.preset ?? null,
			})),
		defaultReviewers: settings.defaultReviewers ?? null,
		defaultMode: settings.defaultMode ?? null,
		modes: Object.values(settings.modes).map((mode) => ({
			name: mode.name,
			label: mode.label,
			strength: mode.strength,
			reviewers: mode.reviewers ?? null,
			description: mode.description ?? null,
		})),
		warnings: settings.warnings,
	});
}

/**
 * `review({ doctor: true })`：只回答「这套配置现在能不能跑」，不评审任何改动。
 *
 * 与真实执行共用同一个可执行文件解析器（{@link probeCliReviewer}），所以自检结论和实际
 * 行为不会漂移。CLI 只跑一次 `--version`；子智能体只查 provider 是否注册——**不做模型
 * 连通性测试**（那要真发请求，属于显式动作，这里不代劳）。
 */
async function buildDoctorReport(ctx, settings, cwd, registered = settings) {
	const profile = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
	const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : ctx.subagents;
	const enabled = settings.reviewers.filter((reviewer) => reviewer.enabled);
	const lines = [
		'## dsh-review 环境自检',
		'',
		`- 工作目录：\`${cwd}\``,
		typeof profile?.dir === 'string' && profile.dir.length > 0
			? `- profile：\`${profile.dir}\`（CLI 定位会从这个 profile 的依赖里兜底找）`
			: '- profile：拿不到 `profileContext`，CLI 只能按 PATH 与常见安装目录找',
		`- 启用的评审者：${enabled.length} 个`,
		schemaAvailable
			? `- GUI 配置表单：✅ 已加载 Config schema（schemastery：\`${schemaSource ?? '插件依赖'}\`）`
			: '- GUI 配置表单：❌ 找不到 `@deepseek-ai/schemastery`，GUI 不会显示配置表单（配置请改 profile 的 cordis.patch.yml，或把依赖装进 profile）',
		typeof ctx.get === 'function' && ctx.get('sessionProjections') !== undefined
			? '- 评审状态条：✅ `sessionProjections` 已注册，对话与输入框之间会显示轮次与评审者'
			: '- 评审状态条：❌ 宿主没有 `sessionProjections`，对话与输入框之间不会显示状态条（工具本身仍可用）',
		typeof ctx.get === 'function' && ctx.get('workspaceChanges') !== undefined
			? '- 改动检测：✅ `workspaceChanges` 已注册，当前轮没有文件改动时会自动隐藏状态条'
			: '- 改动检测：⚠️ 宿主没有 `workspaceChanges`，状态条只在对话非空时显示（不会按改动隐藏）',
	];

	// doctor 要能承担“准确清单以我为准”的承诺：不只报数量，还要报当前默认集合/模式。
	const currentIds = enabled.map((reviewer) => reviewer.id);
	const registeredIds = registered.reviewers.filter((reviewer) => reviewer.enabled).map((reviewer) => reviewer.id);
	const sameDescription = descriptionFingerprint(settings) === descriptionFingerprint(registered);
	lines.push(
		`- 工具描述快照：${sameDescription ? '✅ 与当前配置一致' : '⚠️ 与当前配置不一致；重启宿主后描述才会更新'}`,
		`- 当前默认评审者：${settings.defaultReviewers !== undefined && settings.defaultReviewers.length > 0 ? settings.defaultReviewers.map((id) => `\`${id}\``).join('、') : '（未设置，调用时必须显式给 reviewers）'}`,
		`- 当前默认模式：${settings.defaultMode === undefined ? '（未设置）' : `\`${settings.defaultMode}\``}`,
		`- 当前模式：${Object.keys(settings.modes).length > 0 ? Object.keys(settings.modes).map((name) => `\`${name}\``).join('、') : '（无）'}`,
	);
	if (!sameDescription) {
		lines.push(
			`  - 评审者：快照 ${registeredIds.length > 0 ? registeredIds.map((id) => `\`${id}\``).join('、') : '（无）'} → 当前 ${currentIds.length > 0 ? currentIds.map((id) => `\`${id}\``).join('、') : '（无）'}`,
			`  - 默认集合：快照 ${registered.defaultReviewers === undefined ? '（未设置）' : `\`${registered.defaultReviewers.join(',')}\``} → 当前 ${settings.defaultReviewers === undefined ? '（未设置）' : `\`${settings.defaultReviewers.join(',')}\``}`,
		);
	}

	if (enabled.length === 0) {
		lines.push('', '没有启用任何评审者：请在插件 config 里配置 `reviewers` / `agents`，并把它选进 `defaultReviewers` 或某个模式。');
		return lines.join('\n');
	}

	for (const reviewer of enabled) {
		lines.push('', `### \`${reviewer.id}\`（${reviewer.kind}，${reviewer.label}）`);
		if (reviewer.kind === 'cli') {
			// 与真实执行共用同一份透传环境：否则 PATH 靠 envPassthrough 传进来的部署里，
			// 自检会把「真跑得起来」的 CLI 报成没装（定位函数相同，环境不同结论一样会漂）。
			const env = reviewerEnv(settings, reviewer);
			const probe = await probeCliReviewer(ctx, reviewer, env);
			if (probe.ok) {
				lines.push(`- 定位：✅ \`${probe.executable}\``, `  - 来源：${probe.source}`);
				// 显式探活：有超时；环境只用白名单键（凭据类变量本来就不会被带进来）。
				const version = await checkCliVersion(ctx, probe.executable, cwd, env);
				lines.push(`- \`--version\`：${version.ok ? '✅' : '❌'} ${version.detail}`);
				if (!version.ok) lines.push('  - 可执行文件找到了但跑不起来：检查它是否可执行、架构是否匹配、依赖是否完整。');
			} else {
				lines.push(`- 定位：❌ ${probe.error}`);
				lines.push('- 处理：把该 CLI 装成这个 profile 的**直接依赖**（preset 的 `package` 字段会自动定位），或在该评审者的 `executable` 里写绝对路径。');
			}
			continue;
		}
		if (subagents === undefined || subagents === null) {
			lines.push('- ❌ `ctx.subagents` 服务不可用（需要 `@deepseek-ai/dsh-subagent` 与一个 provider）');
			lines.push(`- 模型：${reviewer.agentProvider ?? '(默认)'}${reviewer.agentModel === undefined ? '' : `/${reviewer.agentModel}`}（未做连通性测试）`);
			continue;
		}
		// 只查 provider 注册不够：0.1.x 上 provider 也在，但服务没有 startActivation()，
		// 真实评审会在启动那一步才炸——自检必须把接口形状也照出来。
		const canStart = typeof subagents.startActivation === 'function';
		if (canStart) {
			lines.push('- 启动接口：✅ `startActivation()`');
		} else {
			lines.push('- 启动接口：❌ 宿主没有 `ctx.subagents.startActivation()`（本插件 2.x 需要 DSH >= 0.2.1；0.1.x 的 `start()` 已不再支持）');
		}
		let provider;
		try {
			provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(reviewer.provider) : undefined;
		} catch {
			provider = undefined;
		}
		lines.push(`- provider \`${reviewer.provider}\`：${provider === undefined ? '❌ 没有注册' : '✅ 已注册'}`);
		if (provider !== undefined && reviewer.agentPreset !== undefined && provider.capabilities?.agentPreset !== true) {
			lines.push(`- agent preset \`${reviewer.agentPreset}\`：❌ provider \`${reviewer.provider}\` 不支持独立 preset（spawn 支持；fork 会继承父会话）`);
		}
		if (provider !== undefined && (reviewer.agentProvider !== undefined || reviewer.agentModel !== undefined) && provider.capabilities?.agentOptions === false) {
			lines.push(`- 模型覆盖：❌ provider \`${reviewer.provider}\` 不支持 agentOptions，agentProvider/agentModel 会被拒绝`);
		}
		lines.push(`- 模型：${reviewer.agentProvider ?? '(默认)'}${reviewer.agentModel === undefined ? '' : `/${reviewer.agentModel}`}（未做连通性测试）`);
	}

	lines.push(
		'',
		'### 说明',
		'',
		'- 自检不评审任何改动、不起评审者；CLI 只跑一次 `--version`。',
		'- 子智能体的模型连通性不在自检范围内：那需要真的发一次请求。',
		'- 工具描述与参数是**注册时**快照：宿主不会因为 profile 依赖变化而重载插件代码。上面已列出当前配置；两者不一致时以当前配置为准，重启宿主后描述才会更新。',
	);
	return lines.join('\n');
}

/* ────────────────────────────── 运行时辅助 ────────────────────────────── */

/** 合并多个 AbortSignal；宿主 Node 没有 `AbortSignal.any` 时手工桥接。 */
function combineAbortSignals(signals) {
	const list = signals.filter((signal) => signal !== undefined && signal !== null);
	if (list.length === 0) return new AbortController().signal;
	if (list.length === 1) return list[0];
	if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
	const controller = new AbortController();
	const relay = (signal) => {
		if (!controller.signal.aborted) controller.abort(signal.reason);
	};
	for (const signal of list) {
		if (signal.aborted) {
			relay(signal);
			break;
		}
		signal.addEventListener('abort', () => relay(signal), { once: true });
	}
	return controller.signal;
}

/** 会话工作目录；拿不到就退回宿主进程 cwd。 */
function resolveCwd(exec) {
	const fromAgent = exec.agent?.session?.header?.cwd;
	if (typeof fromAgent === 'string' && fromAgent.length > 0) return fromAgent;
	return process.cwd();
}

function assertDirectory(path) {
	try {
		if (statSync(path).isDirectory()) return;
	} catch {
		/* 落到下面的统一报错 */
	}
	throw new Error(`工作目录不可用：${path}`);
}

/** 读回 job 输出环里的分片（环里只有报告正文）。 */
function renderRing(chunks, lossy, spillPaths) {
	let body = chunks.map((chunk) => chunk.text).join('');
	if (lossy || chunks.some((chunk) => chunk.gapBefore === true)) {
		const files = spillPaths.length > 0 ? spillPaths.join(', ') : '(不可用)';
		body += `${body.length > 0 && !body.endsWith('\n') ? '\n' : ''}[部分输出被丢弃；完整输出：${files}]`;
	}
	return body;
}

/** 取消后把 job 收到终态，避免留下没人认领的记录。 */
async function stopJob(ctx, jobId, owner, reason) {
	try {
		ctx.jobs.kill(jobId, owner, reason);
	} catch {
		/* 已经结束 */
	}
	try {
		await ctx.jobs.wait(jobId, 10_000, owner);
	} catch {
		/* 等不到也照样移除 */
	}
	try {
		ctx.jobs.remove(jobId, owner);
	} catch {
		/* 已被移除 */
	}
}

/* ────────────────────────────── 插件入口 ────────────────────────────── */

export function apply(ctx, config) {
	// 保留原始 config：volatile 字段是「活」的盒子，GUI 改完立刻反映在下次 resolve 上。
	const rawConfig = config;
	const snapshot = () => resolveSettings(unwrapConfig(rawConfig));
	const settings = snapshot();
	const toolDescription = buildToolDescription(settings);
	const parameters = buildParameters(settings);

	const disposeTool = ctx.tools.register({
		name: 'review',
		description: toolDescription,
		parameters,
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: typeof value.report === 'string' ? value.report : '' }],
		},
		presentCall: (args) => {
			const parsed = isRecord(args) ? args : {};
			// 自检不选评审者：配置坏掉时它恰恰最有用，不能因为 selectReviewers 抛错
			// 让卡片先崩。普通调用也吞掉解析错误，把真正的报错留给 execute。
			if (parsed.doctor === true) return { card: 'terminal', title: 'review(doctor)' };
			const live = snapshot();
			let ids;
			try {
				const mode = resolveMode(live, typeof parsed.mode === 'string' ? parsed.mode : undefined);
				const requested = Array.isArray(parsed.reviewers) && parsed.reviewers.length > 0 ? parsed.reviewers : undefined;
				ids = selectReviewers(live, mode, requested).map((reviewer) => reviewer.id);
			} catch {
				const raw = Array.isArray(parsed.reviewers) && parsed.reviewers.length > 0 ? parsed.reviewers : live.defaultReviewers ?? [];
				ids = raw.length > 0 ? raw : ['default'];
			}
			if (ids.length === 0) ids = ['default'];
			return {
				card: 'terminal',
				title: describeCall(ids.map((id) => ({ id })), {
					base: typeof parsed.base === 'string' ? parsed.base : '',
					commit: typeof parsed.commit === 'string' ? parsed.commit : '',
					instructions: typeof parsed.instructions === 'string' ? parsed.instructions : '',
				}),
			};
		},
		async execute(rawArgs, exec) {
			// 每次调用现读配置：GUI 里 volatile 字段改完立刻生效，不必等重载。
			const live = snapshot();
			const target = validateArgs(rawArgs);
			const mode = resolveMode(live, target.mode);
			const cwd = resolveCwd(exec);
			assertDirectory(cwd);
			// 自检要在选评审者之前：配置坏掉（一个都没启用）时它恰恰最有用。
			if (target.doctor === true) {
				const report = await buildDoctorReport(ctx, live, cwd, settings);
				return { kind: 'completed', status: 'completed', reviewers: [], report };
			}
			// 解析失败就地报错，模型能马上改参数重试。
			const reviewers = selectReviewers(live, mode, target.reviewers);
			const owner = exec.agent?.id;
			const ids = reviewers.map((reviewer) => reviewer.id);
			const label = describeCall(reviewers, target);
			// 范围 + 关注点：只有 promptReplacesRange 的评审者收不了（CLI 的限制），子智能体两者都能收。
			// 全都被限制才报错——放在起 job 之前，这样是即时的工具错误，而不是失败的后台任务。
			const cliOnly = reviewers.filter((reviewer) => reviewer.promptReplacesRange);
			if (target.base.length + target.commit.length > 0 && target.instructions.length > 0 && cliOnly.length === reviewers.length) {
				// 给出的必须是真能走通的路：mode 的 prompt 对有范围的 codex 同样会被跳过
				// （nativePrompt 只在没范围时才投递），把它写成建议只会让调用方再撞一次。
				throw new Error(
					`范围与 instructions 不能同时交给这些评审者（${cliOnly.map((reviewer) => reviewer.id).join('、')}）：它们是「[PROMPT] 与范围开关互斥」的 CLI（如 codex 的 \`exec review\`）。只能二选一：要范围就去掉 instructions（想同时保留关注点，加一个 subagent 评审者，它两者都能收）；要关注点就去掉 base/commit，改为评审未提交改动——instructions 才会作为 PROMPT 传给这些 CLI。把关注点写进 mode 的 prompt 也不行——有范围时模式提示词同样会被跳过。`,
				);
			}

			// 调用级预算从范围校验开始计时；否则 git 校验卡住时 timeoutMs 不兑现。
			const callTimeout = target.timeoutMs;
			const hardTimeout = live.hardTimeoutMs;
			let limit;
			if (callTimeout > 0 && (hardTimeout <= 0 || callTimeout <= hardTimeout)) limit = { source: 'call', ms: callTimeout };
			else if (hardTimeout > 0) limit = { source: 'hard', ms: hardTimeout };
			const callController = new AbortController();
			const jobStops = { timedOut: false, limit };
			const callSignal = combineAbortSignals([exec.signal, callController.signal]);
			let timer;
			if (limit !== undefined) {
				timer = setTimeout(() => {
					// 用户先取消时 callSignal 已经 abort；后到的定时器不能把原因改写成超时。
					if (callSignal.aborted) return;
					jobStops.timedOut = true;
					callController.abort(limit.source === 'call' ? `超过本次调用 timeoutMs=${limit.ms}ms` : `超过 ${limit.ms}ms 硬上限`);
				}, limit.ms);
				timer.unref?.();
			}

			// 先确认 base/commit 真的存在：否则会白起一轮评审者，最后报 completed 却什么都没评。
			// 这段也受本次调用预算约束。
			let badRevision;
			try {
				badRevision = await assertRevisionExists(ctx, cwd, target, callSignal);
			} catch (error) {
				if (timer !== undefined) clearTimeout(timer);
				throw error;
			}
			if (callSignal.aborted) {
				if (timer !== undefined) clearTimeout(timer);
				if (jobStops.timedOut) throw new Error(`review 已超时：${String(callSignal.reason ?? '超过本次调用预算')}`);
				throw new Error(`review 已取消（${String(callSignal.reason ?? 'cancelled')}）`);
			}
			if (badRevision !== undefined) {
				if (timer !== undefined) clearTimeout(timer);
				throw new Error(badRevision);
			}

			const workdir = await mkdtemp(join(tmpdir(), 'dsh-review-'));
			const reportPath = join(workdir, 'report.md');

			/** `run` 同步赋值；结论在生产者结算前写进输出环。 */
			const jobId = ctx.jobs.start({
				kind: 'review',
				label,
				...(owner === undefined ? {} : { owner }),
				// 把 job 关联回发起它的工具调用：job 卡片、评审状态投影都能据此对齐同一次调用。
				...(typeof exec.callId === 'string'
					? { toolCall: { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId } }
					: {}),
				run: (job) => {
					// 预算与 controller 在进入 job 之前就建好，范围校验也算在 timeoutMs 内。
					const controller = callController;
					job.updateProgress(`reviewing (${ids.join(', ')})`);
					// 心跳：子智能体实测能跑 20 分钟以上，而中间没有任何输出，调用方只能靠猜。
					// 定期把「谁还在跑 + 已用时」写进进度，至少能看出它没死。
					const pending = new Set(ids);
					const startedAt = Date.now();
					let heartbeat;
					heartbeat = setInterval(() => {
						if (pending.size === 0) return;
						const seconds = Math.round((Date.now() - startedAt) / 1000);
						const elapsed = `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
						job.updateProgress(`reviewing (${[...pending].join(', ')}) — ${elapsed}`);
					}, __internals.heartbeatMs);
					heartbeat.unref?.();

					const done = (async () => {
						try {
							const changes = await collectChanges(ctx, live, target, cwd, controller.signal, { packet: needsPacket(reviewers) });

							// 采集阶段撞上调用级/全局上限时，git 可能已经中止、summary 看起来是空的；
							// 必须先按“已中止”收口，不能落进下面「没有改动」的成功出口。
							if (controller.signal.aborted) {
								throw new Error(`review 已中止：${String(controller.signal.reason ?? 'cancelled')}`);
							}

							// 没有改动就不要打扰评审者：多花几分钟、还容易换来一堆幻觉 findings。
							const gitBroke = changes.gitFailed === true;
							if (changes.isRepo && !gitBroke && changes.summary.empty) {
								// 材料说明（例如「不是 git 仓库」）必须一起给：否则在非 git 目录里
							// 用户只会看到「未检测到需要评审的改动」，完全不知道原因。
							const emptyParts = ['## 评审范围', '', `- 范围：${describeTarget(target)}`, '- 未检测到需要评审的改动（该范围内没有文件变化）。'];
							if (changes.notes.length > 0) emptyParts.push('', '### 材料说明', '', ...changes.notes.map((note) => `- ${note}`));
							if (live.warnings.length > 0) emptyParts.push('', '### 配置告警', '', ...live.warnings.map((warning) => `- ${warning}`));
							const empty = emptyParts.join('\n');
								job.append(empty, { channel: 'stdout' });
								// 短路也不能漏临时目录：它在 ctx.jobs.start 之前就建好了。
								await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
								return { status: 'completed', detail: '没有改动' };
							}

							const brief = buildBrief({ settings: live, mode, target, changes, extraNotes: changes.notes });
							const nativePrompt = buildNativePrompt(mode, target, live.language === 'en' ? 'en' : 'zh');
							const briefText = flattenBrief(brief);
							const scopeGiven = target.base.length > 0 || target.commit.length > 0;

							// 只进报告脚注、不进评审者提示词：这些是给读结论的人看的。
							const reportNotes = [...changes.notes];
							/** 提示词被 argv 字节闸截断的评审者 id。 */
							const argvTruncated = [];
							const rangeFirst = reviewers.filter((reviewer) => reviewer.promptReplacesRange);
							const skippedIds = rangeFirst.map((reviewer) => reviewer.id);
							const hasModePrompt = modePrompt(mode) !== undefined;
							const hasInstructions = target.instructions.length > 0;
							// 脚注只在「确实有东西被跳过」时出现：`nativePrompt` 现在永远有值（含输出格式），
							// 拿它当判据会在没配任何模式/指令时也报「提示词没有传递」，纯属吓人。
							if (scopeGiven && skippedIds.length > 0 && (hasModePrompt || hasInstructions)) {
								const what = [hasModePrompt ? '模式的提示词' : '', hasInstructions ? 'instructions' : ''].filter((part) => part.length > 0).join(' 和 ');
								reportNotes.push(
									`${skippedIds.join('、')}：因为指定了 base/commit，${what}没有传递给它们——该 CLI 的 PROMPT 与范围开关互斥，而范围优先。需要「范围 + 关注点」请改用 subagent 评审者，或把关注点写进自定义 CLI 的命令模板。`,
								);
							}

							const outcomes = await Promise.all(
								reviewers.map((reviewer, index) => {
									// 每个评审者结束后从 pending 里摘掉，心跳里就只剩真正在跑的。
									const track = (promise) => promise.finally(() => pending.delete(reviewer.id));
									// 以 argv 投递提示词的评审者要过单参数字节闸，stdin 投递不受限。
									// 截断会被记进报告脚注：评审者看到的材料比别人少这件事必须可见。
									let promptText;
									if (reviewer.kind === 'cli') {
										if (reviewer.promptVia === 'stdin') promptText = reviewer.promptReplacesRange ? (scopeGiven ? undefined : nativePrompt) : briefText;
										else {
											const raw = reviewer.promptReplacesRange ? (scopeGiven ? undefined : nativePrompt) : briefText;
											if (raw === undefined) promptText = undefined;
											else {
												const clamped = clampForArgv(raw, live.maxArgBytes);
												if (clamped.clamped) argvTruncated.push(reviewer.id);
												promptText = clamped.text;
											}
										}
									}
									return track(
										runReviewer(ctx, reviewer, {
											cwd,
											target,
											brief,
											changes,
											settings: live,
											agent: exec.agent,
											signal: controller.signal,
											jobStops,
											promptText,
											reportPath: reviewer.capture === 'report' ? join(workdir, `report-${safeFileName(reviewer.id, index)}.md`) : reportPath,
										}),
									);
								}),
							);

							// 评审者自己带回来的说明（例如「结论是 stdout 回退来的」）。
							for (const outcome of outcomes) {
								if (typeof outcome.note === 'string' && outcome.note.length > 0) reportNotes.push(outcome.note);
							}
							// 子智能体在大 diff 上很容易烧满墙钟上限且零产出：给出可操作的下一步。
							// 只认结构化标志 timedOut——以前对 detail 做中文正则，插件自己产出的
							// 「超过 Xms」匹配不上（真超时静默），job 取消的 'tool call aborted'
							// 又会误命中（给出「调高 timeoutMs」的错误建议）。
							for (const outcome of outcomes) {
								if (outcome.timedOut === undefined) continue;
								const kind = reviewers.find((reviewer) => reviewer.id === outcome.id)?.kind;
								if (outcome.timedOut === 'call') {
									reportNotes.push(`${outcome.id}：被本次调用的 \`timeoutMs\` 中止。可以调大 timeoutMs，或先用 \`base\`/\`commit\` 缩小范围。`);
								} else if (outcome.timedOut === 'job') {
									reportNotes.push(`${outcome.id}：被本次评审的墙钟上限（\`hardTimeoutMs\`）中止。可以调大 hardTimeoutMs，或先用 \`base\`/\`commit\` 缩小范围。`);
								} else if (kind === 'subagent') {
									reportNotes.push(`${outcome.id}：子智能体在大范围上被该评审者的 \`timeoutMs\` 中止。这个 diff 建议只用 CLI 评审者，或调高对应的超时设置；也可以先用 \`base\`/\`commit\` 缩小范围。`);
								}
							}
							if (argvTruncated.length > 0) {
								reportNotes.push(
									`${[...new Set(argvTruncated)].join('、')}：提示词超过单参数 ${live.maxArgBytes} 字节上限，diff 被截断后才交给 CLI。这些评审者看到的材料比其他人少——「没有问题」不等于覆盖了全部改动；要看完整 diff 请调小 maxDiffChars 分批评审，或改用 subagent 评审者（它自己去读仓库，不受这个上限影响）。`,
								);
							}

							const completed = outcomes.filter((outcome) => outcome.status === 'completed').length;
							const status = completed > 0 ? 'completed' : 'failed';
							const detail = `${completed}/${outcomes.length} 个评审者完成`;

							const draft = composeReport({ reviewers, outcomes, changes, mode, target, notes: reportNotes, warnings: live.warnings });
							const truncation = truncateText(draft, live.maxResultChars);
							let shown = draft;
							if (truncation.truncated) {
								// 只有截断时才需要把全文留在盘上。写入失败时绝不能继续给一个
								// “完整报告：路径”的承诺——用不含 reportPath 的 draft 截断并明说失败。
								const full = composeReport({ reviewers, outcomes, changes, mode, target, reportPath, truncated: true, notes: reportNotes, warnings: live.warnings });
								let saved = false;
								let saveError;
								try {
									await __internals.writeReport(reportPath, full, 'utf8');
									saved = true;
								} catch (error) {
									saveError = messageOf(error);
								}
								if (saved) {
									shown = `${truncateText(full, live.maxResultChars).text}\n\n[报告已截断；完整报告：${reportPath}]`;
								} else {
									shown = `${truncation.text}\n\n[报告已截断；完整报告保存失败（${saveError ?? '未知错误'}）]`;
									await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
								}
							} else {
								// 全文已经在结果里，临时目录（各 CLI 的 --output-last-message 等）不再被引用。
								await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
							}

							job.append(shown, { channel: 'stdout' });
							return { status, detail };
						} catch (error) {
							const detail = messageOf(error);
							job.append(`[review 失败] ${detail}`, { channel: 'stdout' });
							// 失败路径不引用任何落盘文件，直接收掉临时目录。
							await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
							return { status: 'failed', detail };
						} finally {
							if (timer !== undefined) clearTimeout(timer);
							// 心跳必须在**所有**出口停掉：空改动短路与失败路径以前会漏，interval 会一直
							// 持有 job 引用，并对已结算的 job 继续写进度。
							clearInterval(heartbeat);
						}
					})();

					return {
						done,
						cancel: (reason) => {
							if (timer !== undefined) clearTimeout(timer);
							// 子智能体/CLI 的下游可能收得慢；取消时立刻停心跳，别继续对已取消的 job 写进度。
							clearInterval(heartbeat);
							if (!controller.signal.aborted) controller.abort(typeof reason === 'string' && reason.length > 0 ? reason : 'cancelled');
						},
					};
				},
			});

			const runningValue = (status) => ({
				kind: 'running',
				jobId,
				status,
				reviewers: ids,
				report: `review 仍在运行（job ${jobId}，${label}）。用 job_output 读取结果、job_kill 终止；跑完会自动通知。`,
			});

			// `waitMs <= 0` 是「纯后台」：注册表不接受非正数的等待时长，也不必等。
			if (live.waitMs <= 0) return runningValue('running');

			let view;
			try {
				view = await ctx.jobs.wait(jobId, live.waitMs, owner, exec.signal);
			} catch (error) {
				await stopJob(ctx, jobId, owner, 'tool call aborted');
				throw new Error(`review 已取消（${messageOf(error)}）。`);
			}

			if (view.status === 'running' || view.status === 'stopping') return runningValue(view.status);

			// 结论就是输出环里的那一份：后台路径（job_output）与就地返回走同一份文本。
			const read = ctx.jobs.read(jobId, owner);
			ctx.jobs.remove(jobId, owner);
			const report = renderRing(read.chunks, read.lossy, read.job.output.spillPaths ?? []);
			return {
				kind: 'completed',
				status: view.status,
				...(view.detail === undefined ? {} : { detail: view.detail }),
				reviewers: ids,
				report: report.trim().length > 0 ? report.trim() : '(review 没有输出)',
			};
		},
	});

	// 可选：把模式的 when 策略写进系统提示词。默认关闭 —— 插件不替用户做约束。
	const disposers = [disposeTool];

	// 评审状态投影：review job 的注册 / 结算事件 → 客户端对话与输入框之间的状态条。
	// `sessionProjections` 已在 inject 里声明为硬依赖；这里用 get 取实例，拿不到说明宿主
	// 不满足 engines，doctor 会把这一项报出来。
	const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined;
	if (projections !== undefined && projections !== null && typeof projections.register === 'function') {
		let trackWorkspaceChanges = typeof ctx.get === 'function' && ctx.get('workspaceChanges') !== undefined;
		// workspaceChanges 是可选能力，可能比本插件晚注册；动态依赖回调把它翻成 true。
		if (typeof ctx.inject === 'function') {
			try {
				const disposeInject = ctx.inject(['workspaceChanges'], () => {
					trackWorkspaceChanges = true;
					return () => {
						trackWorkspaceChanges = false;
					};
				});
				if (typeof disposeInject === 'function') disposers.push(disposeInject);
			} catch {
				/* 宿主不支持动态依赖时按 apply 时的探测结果 */
			}
		}
		disposers.push(projections.register(createReviewStatusProjection({ trackWorkspaceChanges: () => trackWorkspaceChanges })));
	}
	// 评审策略段落**始终注册**，但正文用函数按当前配置现算：
	// `injectPolicy` 与模式的 when 都是 GUI 可改的 volatile 字段，注册时算一次会立刻过期
	// （打开注入不生效、关掉还留着旧文本）。返回空串时渲染器会丢掉这一节，所以「不注入」
	// 就等于这一节不存在。
	const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
	if (systemPrompt !== undefined && systemPrompt !== null) {
		let order = 2_899;
		try {
			const base = systemPrompt.getSectionOrder('TOOL_REPORT');
			if (typeof base === 'number') order = base - 1;
		} catch {
			/* 没有这个位置名就用兜底顺序 */
		}
		const disposeSection = systemPrompt.section({
			name: 'review:policy',
			order,
			text: () => {
				const current = snapshot();
				if (!current.injectPolicy) return '';
				return buildPolicyText(current) ?? '';
			},
		});
		disposers.push(disposeSection);
	}

	ctx.effect(() => () => {
		for (const dispose of disposers.reverse()) {
			try {
				dispose?.();
			} catch {
				/* 卸载时不该因为一个 section 失败而卡住 */
			}
		}
	});
}