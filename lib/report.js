/**
 * 评审报告组装。
 *
 * 报告分四段：范围头 → 各评审者结论 → 可选的汇总 → 材料说明/配置告警。
 * 结果文本一律先落盘再按 `maxResultChars` 首尾截断，截断时在结果里给出完整路径，
 * 这样「工具结果」与「job_output 读到的」永远是同一份东西。
 */

import { describeTarget } from './changes.js';

/** 首尾截断；顺带告诉调用方完整正文在哪。 */
export function truncateText(text, limit) {
	if (typeof limit !== 'number' || limit <= 0 || text.length <= limit) return { text, truncated: false };
	const head = Math.floor(limit * 0.6);
	const tail = limit - head;
	const omitted = text.length - limit;
	return { text: `${text.slice(0, head)}\n\n[… 中间 ${omitted} 字符省略 …]\n\n${text.slice(-tail)}`, truncated: true };
}

function statusBadge(outcome) {
	if (outcome.status === 'completed') return '';
	return ` — **${outcome.status === 'failed' ? '失败' : outcome.status}**${outcome.detail === undefined ? '' : `：${outcome.detail}`}`;
}

function formatDuration(ms) {
	if (typeof ms !== 'number' || ms <= 0) return '';
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 一份供模型阅读的完整报告。 */
export function composeReport({ reviewers, outcomes, changes, mode, target, synthesis, reportPath, truncated, notes, warnings }) {
	const sections = [];

	const header = [`## 评审范围`, '', `- 范围：${describeTarget(target)}`];
	if (changes !== undefined && changes.summary !== undefined && changes.summary.files > 0) {
		header.push(`- 变更规模：${changes.summary.files} 个文件，+${changes.summary.additions} / -${changes.summary.deletions}`);
	}
	if (mode !== undefined) header.push(`- 模式：\`${mode.name}\`（${mode.strength}）`);
	header.push(`- 评审者：${reviewers.map((reviewer) => `\`${reviewer.id}\``).join('、')}`);
	sections.push(header.join('\n'));

	const body = [];
	for (const outcome of outcomes) {
		const duration = formatDuration(outcome.elapsedMs);
		const target = typeof outcome.target === 'string' && outcome.target.length > 0 ? `, ${outcome.target}` : '';
		const title = `### ${outcome.label} \`${outcome.id}\`（${outcome.kind}${target}${duration.length > 0 ? `, ${duration}` : ''}）${statusBadge(outcome)}`;
		const parts = [title];
		if (outcome.text.trim().length > 0) parts.push(outcome.text.trim());
		if (outcome.status !== 'completed') {
			parts.push(outcome.text.trim().length > 0 ? '_（以上内容可能不完整）_' : '_该评审者没有产出结论。_');
			if (typeof outcome.diagnostics === 'string' && outcome.diagnostics.trim().length > 0) {
				parts.push(`<details><summary>诊断输出</summary>\n\n\`\`\`\n${outcome.diagnostics.trim()}\n\`\`\`\n\n</details>`);
			}
		}
		body.push(parts.join('\n\n'));
	}
	sections.push(body.join('\n\n---\n\n'));

	if (synthesis !== undefined && synthesis.text.trim().length > 0) {
		const title = synthesis.status === 'completed' ? '## 汇总（评审结论合并）' : `## 汇总 — 失败：${synthesis.detail ?? ''}`;
		sections.push(`${title}\n\n${synthesis.text.trim()}`);
	}

	const footnotes = [];
	if (Array.isArray(notes) && notes.length > 0) footnotes.push(['### 材料说明', '', ...notes.map((note) => `- ${note}`)].join('\n'));
	if (Array.isArray(warnings) && warnings.length > 0) footnotes.push(['### 配置告警', '', ...warnings.map((warning) => `- ${warning}`)].join('\n'));
	if (truncated && typeof reportPath === 'string') footnotes.push(`完整报告：\`${reportPath}\``);
	if (footnotes.length > 0) sections.push(footnotes.join('\n\n'));

	return sections.join('\n\n');
}