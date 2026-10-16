/**
 * dsh-review —— DSH Host 插件：给智能体一个通用的 `review` 工具。
 *
 * 一个工具，两种评审者（都是具备完整智能体能力的执行体）：
 *
 * - `cli`：codex / claude / gemini / cursor-agent / 自定义 argv 模板。进程由宿主侧
 *   `ctx.subprocess` 直接起，不走 bash 工具，所以不受 DSH 文件沙箱与命令审批影响
 *   （codex 需要读写 `~/.codex`，在沙箱下会直接 `Operation not permitted`，走审批
 *   又会让每次评审都卡一次）。
 * - `subagent`：`ctx.subagents` 起一个子智能体，可以自己翻仓库、跑只读命令；模型来自
 *   DSH 自己的 provider 配置。默认剔除 `review` 工具，避免「评审者再起评审者」。
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

import { collectChanges, describeCall, describeTarget } from './lib/changes.js';
import { buildBrief, buildNativePrompt, buildPolicyText, flattenBrief } from './lib/prompt.js';
import { composeReport, truncateText } from './lib/report.js';
import { clampForArgv, runReviewer } from './lib/reviewers.js';
import { Config, schemaAvailable, unwrapConfig } from './lib/schema.js';
import { needsPacket, resolveMode, resolveSettings, selectReviewers } from './lib/settings.js';

/** 加载器诊断用的插件名；`cordis.patch.yml` 里的 id 是 `review`。 */
export const name = 'review';

/**
 * GUI 表单的宿主半边：`dsh-settings` 只把 Config schema 里标了 `.volatile()` 的字段
 * 投影成设置页表单，写到 profile patch 层并立即生效。拿不到 schemastery 时这里是
 * undefined —— 插件照常工作，只是 GUI 里没有表单（工具描述会说明）。
 */
export { Config };

/** 仅供自测：把心跳间隔调小，避免用例等 30 秒。 */
export const __internals = { heartbeatMs: 30_000 };

/** 硬依赖：缺任何一个都说明这套组合跑不了这个工具，直接不激活而不是半残。 */
export const inject = ['tools', 'subprocess', 'jobs'];

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

/** 工具描述从配置生成：模型能直接看到「有哪些评审者、哪些模式」。 */
function buildToolDescription(settings) {
	const lines = ['用外部评审者评审代码改动，返回它们的评审结论（findings、风险、建议）。', ''];

	const enabled = settings.reviewers.filter((reviewer) => reviewer.enabled);
	lines.push('可用评审者：');
	if (enabled.length === 0) {
		lines.push('- （没有配置任何评审者：请先在插件 config 里配置 agents / reviewers，即 CLI 智能体或子智能体）');
	} else {
		for (const reviewer of enabled) {
			const target = reviewer.kind === 'cli' ? `可执行 ${reviewer.executable}` : `子智能体 ${reviewer.provider}`;
			lines.push(`- \`${reviewer.id}\`（${reviewer.kind}，${reviewer.label}）：${target}`);
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
		'参数规则：`base`、`commit`、`instructions` **三者最多给一个**（`base` 与 `commit` 互斥；给了 `base`/`commit` 就不能再给 `instructions`——codex CLI 的范围开关与 PROMPT 不能同时出现）。要「某个范围 + 附加关注点」，把关注点写进 `mode` 的提示词。',
		'`reviewers` 只能从上面列出的评审者里选，写别的 id 会直接报错（插件没有「按需指名模型」这条路）。',
		'评审通常要跑几分钟：默认**立即**返回 job id（不等待），用 job_output 读结果，跑完会自动通知；调用方可自行决定什么时候放弃。',
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
				description: `要使用的评审者 id，只能从这些里选：${enabled.map((reviewer) => reviewer.id).join(', ') || '（当前没有启用的评审者）'}。${reviewersHint}`,
			},
			mode: { type: 'string', description: `评审模式（强度、提示词、评审者集合）。${modeHint}` },
			base: { type: 'string', description: '评审当前工作区相对该分支的改动（如 "main"）。与 commit、instructions 互斥，三者最多给一个。' },
			commit: { type: 'string', description: '评审该提交引入的改动（commit sha）。与 base、instructions 互斥，三者最多给一个。' },
			instructions: {
				type: 'string',
				description: '附加评审指令，用来聚焦关注点（如「只看并发与错误处理」）。与 base、commit 互斥；这时按未提交的改动评审。',
			},
		},
	};
}

/**
 * 校验模型参数。值只作为独立 argv / 消息正文传递，不存在 shell 拼接；这里挡住的是
 * 无意义的形态。
 *
 * `base`/`commit` 与 `instructions` 互斥不是插件的取舍：codex CLI 自己声明
 * `[PROMPT]` 不能与 `--uncommitted`/`--base`/`--commit` 同时出现。与其让同一个参数
 * 在不同评审者上语义不一致，不如在工具层明确拒绝，把「范围 + 关注点」交给 mode。
 */
function validateArgs(raw) {
	const args = isRecord(raw) ? raw : {};
	const base = typeof args.base === 'string' ? args.base.trim() : '';
	const commit = typeof args.commit === 'string' ? args.commit.trim() : '';
	const instructions = typeof args.instructions === 'string' ? args.instructions.trim() : '';

	if (base.length > 0 && commit.length > 0) {
		throw new Error('base 与 commit 只能给一个：base 评审相对分支的改动，commit 评审某个提交的改动。');
	}
	if (instructions.length > 0 && (base.length > 0 || commit.length > 0)) {
		throw new Error('base / commit 不能与 instructions 同时给：codex CLI 里自定义评审指令 [PROMPT] 与范围开关互斥。要「评某个范围 + 附加关注点」请用 mode 的 prompt。');
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

	let reviewers;
	if (args.reviewers !== undefined) {
		if (!Array.isArray(args.reviewers) || args.reviewers.some((entry) => typeof entry !== 'string')) {
			throw new Error('reviewers 必须是字符串数组。');
		}
		reviewers = args.reviewers;
	}
	return { base, commit, instructions, reviewers, mode: typeof args.mode === 'string' ? args.mode : undefined };
}

/* ────────────────────────────── 运行时辅助 ────────────────────────────── */

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
			const ids = Array.isArray(parsed.reviewers) && parsed.reviewers.length > 0 ? parsed.reviewers.join(',') : settings.defaultReviewers?.join(',') ?? 'default';
			const scope = typeof parsed.base === 'string' && parsed.base.trim().length > 0 ? `--base ${parsed.base.trim()}` : typeof parsed.commit === 'string' && parsed.commit.trim().length > 0 ? `--commit ${parsed.commit.trim()}` : '--uncommitted';
			return { card: 'terminal', title: `review(${ids}) ${scope}` };
		},
		async execute(rawArgs, exec) {
			// 每次调用现读配置：GUI 里 volatile 字段改完立刻生效，不必等重载。
			const live = snapshot();
			const target = validateArgs(rawArgs);
			const mode = resolveMode(live, target.mode);
			const cwd = resolveCwd(exec);
			assertDirectory(cwd);
			// 解析失败就地报错，模型能马上改参数重试。
			const reviewers = selectReviewers(live, mode, target.reviewers);
			const owner = exec.agent?.id;
			const ids = reviewers.map((reviewer) => reviewer.id);
			const label = describeCall(reviewers, target);
			const workdir = await mkdtemp(join(tmpdir(), 'dsh-review-'));
			const reportPath = join(workdir, 'report.md');

			/** `run` 同步赋值；结论在生产者结算前写进输出环。 */
			const jobId = ctx.jobs.start({
				kind: 'review',
				label,
				...(owner === undefined ? {} : { owner }),
				run: (job) => {
					const controller = new AbortController();
					let timer;
					if (live.hardTimeoutMs > 0) {
						timer = setTimeout(() => controller.abort(`超过 ${live.hardTimeoutMs}ms 硬上限`), live.hardTimeoutMs);
						timer.unref?.();
					}
					job.updateProgress(`reviewing (${ids.join(', ')})`);
					// 心跳：子智能体实测能跑 20 分钟以上，而中间没有任何输出，调用方只能靠猜。
					// 定期把「谁还在跑 + 已用时」写进进度，至少能看出它没死。
					const pending = new Set(ids);
					const startedAt = Date.now();
					const heartbeat = setInterval(() => {
						if (pending.size === 0) return;
						const seconds = Math.round((Date.now() - startedAt) / 1000);
						const elapsed = `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
						job.updateProgress(`reviewing (${[...pending].join(', ')}) — ${elapsed}`);
					}, __internals.heartbeatMs);
					heartbeat.unref?.();

					const done = (async () => {
						try {
							const changes = await collectChanges(ctx, live, target, cwd, controller.signal, { packet: needsPacket(reviewers) });

							// 没有改动就不要打扰评审者：多花几分钟、还容易换来一堆幻觉 findings。
							const gitBroke = changes.notes.some((note) => note.includes('失败'));
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
							if (scopeGiven && nativePrompt !== undefined && rangeFirst.length > 0) {
								reportNotes.push(
									`${rangeFirst.map((reviewer) => reviewer.id).join('、')}：因为指定了 base/commit，模式的提示词没有传递——该 CLI 的 PROMPT 与范围开关互斥，而范围优先。需要「范围 + 关注点」请改用 subagent 评审者，或把关注点写进自定义 CLI 的命令模板。`,
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
											promptText,
											reportPath: reviewer.capture === 'report' ? join(workdir, `report-${safeFileName(reviewer.id, index)}.md`) : reportPath,
										}),
									);
								}),
							);

							clearInterval(heartbeat);
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
								// 只有截断时才需要把全文留在盘上：结果里给出了路径，不能删。
								const full = composeReport({ reviewers, outcomes, changes, mode, target, reportPath, truncated: true, notes: reportNotes, warnings: live.warnings });
								await writeFile(reportPath, full, 'utf8').catch(() => undefined);
								shown = `${truncateText(full, live.maxResultChars).text}\n\n[报告已截断；完整报告：${reportPath}]`;
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
						}
					})();

					return {
						done,
						cancel: (reason) => {
							if (timer !== undefined) clearTimeout(timer);
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