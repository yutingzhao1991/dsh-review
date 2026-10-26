/**
 * 评审者执行器。
 *
 * 两种 kind 共用同一份输入（{@link ReviewTask}），各自把结论收敛成同一形状的
 * {@link ReviewOutcome}，所以上层编排不必知道对面是 CLI 还是子智能体：
 *
 * - `cli`：宿主侧 `ctx.subprocess` 起进程，argv 由模板展开，不经 shell；
 * - `subagent`：`ctx.subagents` 起一个子智能体，可以自己翻仓库。
 *
 * 每个评审者都有自己的 AbortController（串到 job 的取消信号上）与超时，一个失败
 * 不影响其他评审者。
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_DIAGNOSTIC_CHARS = 4_000;

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** 诊断文本只留尾部：失败原因几乎总在最后几行。 */
function tail(text, limit = MAX_DIAGNOSTIC_CHARS) {
	if (typeof text !== 'string') return '';
	const trimmed = text.trim();
	if (trimmed.length <= limit) return trimmed;
	return `[… 前面 ${trimmed.length - limit} 字符省略 …]\n${trimmed.slice(-limit)}`;
}

/* ────────────────────────────── argv 拼装 ────────────────────────────── */

/** 范围开关；给了原生 PROMPT 时由调用方决定要不要抹掉。 */
function rangeArgs(target) {
	const base = typeof target?.base === 'string' ? target.base.trim() : '';
	const commit = typeof target?.commit === 'string' ? target.commit.trim() : '';
	if (base.length > 0) return ['--base', base];
	if (commit.length > 0) return ['--commit', commit];
	return ['--uncommitted'];
}

/**
 * 展开 argv 模板。占位符一律展开成「零到多个」参数，所以 `{model}` 没配模型时
 * 会自动消失，模板不用写成条件分支。
 */
export function buildCommand(reviewer, { executable, reportPath, promptText, target, ephemeral = true, extraArgs = [] }) {
	const template = reviewer.command;
	// 范围优先：只有当这个预设声明了「PROMPT 取代范围」（codex 的 CLI 约束）时才把范围
	// 开关抹掉。否则 `commit: X` + 模式提示词的调用会退化成评审未提交改动——而报告头
	// 还写着「提交 X 的改动」，这是最坏的一种错。
	// 实测（codex 0.5x）：`codex exec review` 要么给范围开关、要么给自定义指令，两者互斥；
	// 只给指令时它评的仍然是未提交改动（干净工作区会直接说「没有可评审的补丁」），
	// 所以「有 PROMPT 就抹掉 --uncommitted」不会改变范围；显式 base/commit 时范围开关照旧保留
	// （见 index.js 里 scopeGiven 的分支）。
	const dropsRange = reviewer.promptReplacesRange === true && promptText !== undefined;
	const range = dropsRange ? [] : rangeArgs(target);

	const argv = [];
	for (const token of template) {
		switch (token) {
			case '{exe}':
				argv.push(executable);
				break;
			case '{range}':
				argv.push(...range);
				break;
			case '{ephemeral}':
				if (ephemeral) argv.push('--ephemeral');
				break;
			case '{model}':
				if (reviewer.model !== undefined && reviewer.model.length > 0) argv.push(...(reviewer.modelFlag ?? ['--model']), reviewer.model);
				break;
			case '{reportArg}':
				argv.push('--output-last-message', reportPath);
				break;
			case '{report}':
				argv.push(reportPath);
				break;
			case '{prompt}':
				if (reviewer.promptVia !== 'stdin' && promptText !== undefined) argv.push(promptText);
				break;
			case '{promptArg}':
				if (promptText !== undefined) argv.push('--', promptText);
				break;
			case '{extra}':
				argv.push(...(reviewer.extraArgs ?? extraArgs));
				break;
			default:
				argv.push(token);
		}
	}
	return argv;
}

/**
 * 把要作为单个 argv 传出去的提示词压到字节上限内。
 *
 * 保留头部（指令 + 变更统计 + 前面那些文件的 diff），砍掉尾部并留下明确标记——
 * `budgetPatch` 本来也是靠省略尾部文件来控预算的，这样语义一致。按 UTF-8 字节算，
 * 因为 E2BIG 数的是字节而不是字符。
 */
export function clampForArgv(text, maxBytes) {
	if (typeof text !== 'string') return { text: '', clamped: false };
	if (typeof maxBytes !== 'number' || maxBytes <= 0) return { text, clamped: false };
	const bytes = Buffer.byteLength(text, 'utf8');
	if (bytes <= maxBytes) return { text, clamped: false };

	const marker = `\n\n[… 提示词超过 ${maxBytes} 字节的单参数上限（这里 ${bytes} 字节）：后面的 diff 被截断，未纳入本次评审 …]`;
	const markerBytes = Buffer.byteLength(marker, 'utf8');
	// 二分找最大的字符前缀，避免按字节切碎多字节字符。
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, mid), 'utf8') + markerBytes <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return { text: `${text.slice(0, low)}${marker}`, clamped: true };
}

/* ────────────────────────────── CLI ────────────────────────────── */

/**
 * 可信锚点：**当前** profile 的目录，以及它声明的安装锚点。
 *
 * 刻意不扫全部 profile、也不用 `process.cwd()`：这里要交给宿主进程执行的是一个可执行
 * 文件，从别的 profile 或工作仓库里「顺便找到」同名包，等于把执行权交给它们。
 * `profileContext` 是宿主自己注册的服务（`ctx.get('profileContext')`，
 * dsh-app-boot / dsh-settings 也用它取 `dir` / `patchPath`），拿不到就只用 PATH。
 */
function trustedAnchors(ctx) {
	const anchors = [];
	const push = (value) => {
		if (typeof value === 'string' && value.length > 0 && !anchors.includes(value)) anchors.push(value);
	};
	const profile = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
	push(profile?.dir);
	push(profile?.installAnchor);
	return anchors;
}

/**
 * 按包名在 profile 里定位 CLI。
 *
 * 先试 `<anchor>/node_modules/.bin/<name>`——npm/pnpm 给直接依赖都会建这个入口；
 * 再试 preset 明确给出的包内 bin 子路径。
 *
 * 刻意**不解析包根**：`@openai/codex` 只有 `bin`、没有模块入口，实测
 * `require.resolve('@openai/codex', { paths: [profileDir] })` 直接 MODULE_NOT_FOUND，
 * 而 `@openai/codex/bin/codex.js` 子路径能解析。
 */
function cliPackageCandidates(reviewer, anchors) {
	const pkg = typeof reviewer.package === 'string' ? reviewer.package.trim() : '';
	if (pkg.length === 0) return [];
	const names = [];
	const push = (value) => {
		if (typeof value === 'string' && value.length > 0 && !value.includes('/') && !names.includes(value)) names.push(value);
	};
	push(reviewer.executable);
	push(pkg.split('/').filter((part) => part.length > 0).pop());
	const bin = typeof reviewer.bin === 'string' ? reviewer.bin.trim() : '';
	const candidates = [];
	for (const anchor of anchors) {
		for (const name of names) candidates.push(join(anchor, 'node_modules', '.bin', name));
		if (bin.length > 0) candidates.push(join(anchor, 'node_modules', pkg, bin));
	}
	return candidates;
}

/**
 * 探测一个 CLI 评审者当前能不能起得来：**只解析路径，不起进程**。
 *
 * 与真实执行共用 {@link resolveCliExecutable}，所以「探测说能用」与「真跑得起来」不会是
 * 两套判据。`--version` 这类真探活属于显式的 doctor 操作（有时间上限、要起进程），
 * 不放进每次配置解析里。
 */
export async function probeCliReviewer(ctx, reviewer, env = {}) {
	if (reviewer.kind !== 'cli') return { id: reviewer.id, kind: reviewer.kind, ok: true };
	try {
		const resolved = await resolveCliExecutable(ctx, reviewer, env, undefined);
		return { id: reviewer.id, kind: 'cli', ok: true, executable: resolved.executable, source: resolved.source };
	} catch (error) {
		return { id: reviewer.id, kind: 'cli', ok: false, error: messageOf(error) };
	}
}

/**
 * doctor 专用：显式跑一次 `--version`（有超时）。
 *
 * 传空环境：这里不需要凭据，也不该把凭据放进一个诊断用的子进程。
 */
export async function checkCliVersion(ctx, executable, cwd, env = {}, timeoutMs = 5_000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(`超过 ${timeoutMs}ms`), timeoutMs);
	timer.unref?.();
	try {
		const proc = ctx.subprocess.spawn({
			argv: [executable, '--version'],
			cwd,
			env,
			graceMs: 1_000,
			signal: controller.signal,
			stdio: { stdin: 'ignore', stdout: { maxBytes: 8 * 1024 }, stderr: { maxBytes: 8 * 1024 } },
		});
		const outcome = await proc.done;
		const read = (channel) => {
			try {
				return proc.collected?.[channel]?.readFrom(0)?.text ?? '';
			} catch {
				return '';
			}
		};
		const first = (read('stdout') || read('stderr')).trim().split('\n')[0] ?? '';
		return { ok: outcome.exitCode === 0, detail: first.length > 0 ? first : `退出码 ${outcome.exitCode ?? 'none'}` };
	} catch (error) {
		return { ok: false, detail: messageOf(error) };
	} finally {
		clearTimeout(timer);
	}
}

/** codex / claude 这些 CLI 常装在 PATH 之外，按常见位置兜底找一遍。 */
export async function resolveCliExecutable(ctx, reviewer, env, signal) {
	const name = reviewer.executable;
	if (typeof name !== 'string' || name.length === 0) {
		throw new Error(`评审者 ${reviewer.id} 没有配置 executable。`);
	}
	const candidates = [{ path: name, source: '配置的 executable' }];
	if (!name.includes('/')) {
		const dirs = [join(homedir(), '.local', 'bin'), join(homedir(), '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
		for (const dir of dirs) candidates.push({ path: join(dir, name), source: '常见安装位置' });
	}
	for (const path of cliPackageCandidates(reviewer, trustedAnchors(ctx))) {
		candidates.push({ path, source: `profile 里的依赖 ${reviewer.package}` });
	}
	const tried = [];
	for (const { path, source } of candidates) {
		try {
			return { executable: await ctx.subprocess.resolveExecutable(path, env), candidate: path, source };
		} catch (error) {
			tried.push(`${path}（${messageOf(error)}）`);
		}
	}
	throw new Error(`找不到可执行文件 ${name}。可把该 CLI 装成这个 profile 的直接依赖（preset 的 package 字段会自动定位），或在该评审者的 config.executable 里指定绝对路径。已尝试：${tried.join('；')}`);
}

/** 去掉 codex 包在 `<details>` 里的诊断块；整份输出都在里面时保持原样（宁可有噪音也别丢结论）。 */
function stripDiagnosticBlocks(text) {
	const raw = String(text ?? '');
	const stripped = raw.replace(/<details[\s\S]*?<\/details>/gi, '').trim();
	return stripped.length > 0 ? stripped : raw.trim();
}

/**
 * 透传给评审进程的环境：只带显式声明的白名单键。
 *
 * doctor 与真实执行必须用同一份环境——否则 PATH 是通过 `envPassthrough` 传的部署里，
 * 自检会把「真实运行找得到」的 CLI 报成不存在。
 */
export function reviewerEnv(settings, reviewer) {
	const env = {};
	for (const key of [...(settings?.envPassthrough ?? []), ...(reviewer?.envPassthrough ?? [])]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

async function runCli(ctx, reviewer, task, { signal }) {
	const env = reviewerEnv(task.settings, reviewer);
	const { executable } = await resolveCliExecutable(ctx, reviewer, env, signal);
	const argv = buildCommand(reviewer, {
		executable,
		reportPath: task.reportPath,
		promptText: task.promptText,
		target: task.target,
		ephemeral: task.ephemeral,
	});
	const spec = {
		argv,
		cwd: task.cwd,
		env,
		graceMs: 5_000,
		signal,
		stdio: {
			stdin: reviewer.promptVia === 'stdin' && task.promptText !== undefined ? { data: task.promptText } : 'ignore',
			stdout: { maxBytes: task.settings.collectMaxBytes, spill: { maxBytes: task.settings.spillMaxBytes } },
			stderr: { maxBytes: task.settings.collectMaxBytes, spill: { maxBytes: task.settings.spillMaxBytes } },
		},
	};

	let proc;
	try {
		proc = ctx.subprocess.spawn(spec);
	} catch (error) {
		return { status: 'failed', detail: `启动失败：${messageOf(error)}` };
	}

	let outcome;
	try {
		outcome = await proc.done;
	} catch (error) {
		return { status: 'failed', detail: `进程异常：${messageOf(error)}` };
	}

	const read = (channel) => {
		try {
			return proc.collected?.[channel]?.readFrom(0) ?? { text: '', lossy: false, spillPath: undefined };
		} catch {
			return { text: '', lossy: false, spillPath: undefined };
		}
	};
	const stdout = read('stdout');
	const stderr = read('stderr');

	let text = '';
	/** 结论是从 stdout 回退来的（CLI 没写出报告文件），要写进材料说明。 */
	let textFromStdout = false;
	/** 结论取自 stdout（回退或 capture: stdout）——此时 stdout 的截断信息要跟着结论走。 */
	let textFromStdoutChannel = false;
	if (reviewer.capture === 'report') {
		try {
			text = await readFile(task.reportPath, 'utf8');
		} catch {
			text = '';
		}
		if (text.trim().length === 0 && stdout.text.trim().length > 0) {
			// 实测：codex 偶发写不出报告文件（`Failed to write last message file: No such
			// file or directory`），但 stdout 里有完整结论。文件缺失就判失败会白丢一份评审。
			text = stripDiagnosticBlocks(stdout.text);
			textFromStdout = true;
			textFromStdoutChannel = true;
		}
	} else {
		text = stdout.text;
		textFromStdoutChannel = true;
	}
	/**
	 * stdout 被截断时，结论可能**缺尾部**——恰恰是结论所在的位置。
	 *
	 * 以前只在回退分支写一句「内容完整」：既没看 `lossy`，也丢了 spillPath，读者无从知道
	 * 缺了东西。capture: stdout 的预设（claude / gemini）同样会静默丢输出，所以两条路都要写。
	 */
	const lossyNote =
		textFromStdoutChannel && stdout.lossy === true
			? `${reviewer.id}：结论取自 stdout，而 stdout 已被截断（超过 collectMaxBytes 上限），这里可能缺尾部——完整输出见 ${stdout.spillPath ?? '(不可用)'}。`
			: undefined;

	if (outcome.exitCode !== 0) {
		const diagnostics = [stderr.text, stdout.text].filter((part) => typeof part === 'string' && part.trim().length > 0).join('\n');
		return {
			status: 'failed',
			detail: `退出码 ${outcome.exitCode ?? 'none'}${outcome.signal === null || outcome.signal === undefined ? '' : `，信号 ${outcome.signal}`}`,
			diagnostics: tail(diagnostics),
			text,
		};
	}
	if (text.trim().length === 0) {
		const diagnostics = [stderr.text, stdout.text].filter((part) => typeof part === 'string' && part.trim().length > 0).join('\n');
		return { status: 'failed', detail: '评审者没有输出结论', diagnostics: tail(diagnostics), text: '' };
	}
	return {
		status: 'completed',
		detail: `\`${argv[0]}\` 退出码 0`,
		text,
		...(lossyNote !== undefined
			? { note: lossyNote }
			: textFromStdout
				? { note: `${reviewer.id}：CLI 没有写出报告文件，结论是从 stdout 回退提取的（stdout 未被截断，但可能夹带诊断输出）。` }
				: {}),
	};
}

/* ────────────────────────────── 子智能体 ────────────────────────────── */

function joinContentBlocks(output) {
	if (!Array.isArray(output)) return '';
	return output
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n\n')
		.trim();
}

async function runSubagent(ctx, reviewer, task, { signal }) {
	const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : ctx.subagents;
	if (subagents === undefined || subagents === null) {
		return { status: 'failed', detail: 'ctx.subagents 服务不可用（需要 @deepseek-ai/dsh-subagent 与一个 provider）' };
	}
	// 0.2.1 移除了 SubagentRuntime.start()，改为 startActivation(spec)。宿主太旧时
	// 这里必须明确说版本，而不是让调用方看到 `start is not a function` 去猜。
	if (typeof subagents.startActivation !== 'function') {
		return { status: 'failed', detail: '宿主没有 ctx.subagents.startActivation()：本插件 2.x 需要 DSH >= 0.2.1（0.1.x 的 start() 接口已不再支持）' };
	}
	if (task.agent === undefined || task.agent === null) {
		return { status: 'failed', detail: '拿不到发起会话的 Agent（子智能体评审需要一个 parent）' };
	}
	let provider;
	try {
		provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(reviewer.provider) : undefined;
	} catch {
		provider = undefined;
	}
	if (provider === undefined && typeof subagents.getProvider === 'function') {
		return { status: 'failed', detail: `子智能体 provider "${reviewer.provider}" 没有注册` };
	}

	const agentOptions = {};
	if (reviewer.agentProvider !== undefined) agentOptions.provider = reviewer.agentProvider;
	if (reviewer.agentModel !== undefined) agentOptions.model = reviewer.agentModel;

	// 0.2.1 的 request 不再收 label / signal：它们被提到 startActivation 的 spec 上，
	// 另外多了一个必填的 delivery。`caller` = 只把结果交回本次调用，不往父会话里塞通知。
	const request = {
		prompt: [{ type: 'text', text: `${task.brief.system}\n\n----- \n\n${task.brief.body}` }],
		parent: task.agent,
		...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
		...(reviewer.agentPreset === undefined ? {} : { agentPreset: reviewer.agentPreset }),
	};
	if (reviewer.maxDepth !== undefined && typeof subagents.resolveMaxDepth === 'function') {
		const depth = subagents.resolveMaxDepth(reviewer.maxDepth);
		if (depth !== undefined) request.maxDepth = depth;
	}

	let activation;
	try {
		activation = await subagents.startActivation({
			provider: reviewer.provider,
			label: `review:${reviewer.id}`,
			request,
			signal,
			delivery: 'caller',
		});
	} catch (error) {
		return { status: 'failed', detail: `启动子智能体失败：${messageOf(error)}` };
	}
	/**
	 * 0.2.1 的 spec.signal 只负责**启动前**取消；发布之后要停子智能体只能 dispose()。
	 * 不接这一步，评审者超时/用户取消会一直等 result——表现就是「卡住」，而不是停止。
	 */
	let disposal;
	const disposeOnce = () => {
		if (disposal !== undefined) return disposal;
		try {
			disposal = Promise.resolve(activation.dispose?.()).catch(() => {});
		} catch {
			disposal = Promise.resolve();
		}
		return disposal;
	};
	const onAbort = () => {
		void disposeOnce();
	};
	if (signal.aborted) onAbort();
	else signal.addEventListener('abort', onAbort, { once: true });

	try {
		const result = await activation.result;
		const text = joinContentBlocks(result?.output);
		if (result?.stopReason !== undefined && result.stopReason !== 'completed') {
			return { status: 'failed', detail: `子智能体结束原因 ${result.stopReason}${result.diagnostic === undefined ? '' : `：${result.diagnostic}`}`, text };
		}
		if (text.length === 0) return { status: 'failed', detail: '子智能体没有输出结论', text: '' };
		const routeParts = [reviewer.agentProvider, reviewer.agentModel].filter((part) => typeof part === 'string' && part.length > 0);
		const route = routeParts.length === 0 ? '' : `, ${routeParts.join('/')}`;
		const preset = reviewer.agentPreset === undefined ? '' : `, preset ${reviewer.agentPreset}`;
		return { status: 'completed', detail: `provider ${reviewer.provider}${route}${preset}`, text };
	} catch (error) {
		return { status: 'failed', detail: `子智能体运行失败：${messageOf(error)}` };
	} finally {
		signal.removeEventListener('abort', onAbort);
		try {
			await disposeOnce();
		} catch {
			/* 已经收敛 */
		}
	}
}

/* ────────────────────────────── 调度 ────────────────────────────── */

/**
 * 跑一个评审者，把任何异常都收敛成 failed 结果 —— 一个评审者挂掉不该让整次
 * 评审失败。超时与取消都通过这个评审者自己的 AbortController 表达。
 */
export async function runReviewer(ctx, reviewer, task) {
	const controller = new AbortController();
	/**
	 * 结构化中止原因（`'reviewer'` | `'call'` | `'job'`），取代「对 detail 做中文正则」的判据。
	 *
	 * 以前消费点用 `/超时|aborted|中止/` 匹配 detail：插件自己产出的中止原因
	 * （`超过 ${timeoutMs}ms`、`超过 ${hardTimeoutMs}ms 硬上限`）反而**匹配不上**，
	 * 而 job 被取消时 detail 里的 `'tool call aborted'` 又会误命中——真超时静默、
	 * 用户取消反而被建议「调高 timeoutMs」。
	 *
	 * `'call'` 与 `'job'` 都来自上游，靠 `jobStops.limit.source` 区分；报告必须按实际
	 * 生效的上限归因，不能把所有 job 级超时都写成 `hardTimeoutMs`。
	 */
	let timedOut;
	// 声明在 onAbort 之前：`task.signal` 已经 abort 时 onAbort 会同步执行，那时 timer 还没赋值。
	let timer;
	/** 谁先中止谁说了算：清理慢时后面的入口不能改写已经发生的原因。 */
	const stopOnce = (reason) => {
		if (controller.signal.aborted) return;
		timedOut = reason;
		const limitMs = task.jobStops?.limit?.ms;
		const detail =
			reason === 'reviewer'
				? `超过 ${reviewer.timeoutMs}ms`
				: reason === 'call'
					? `超过本次调用 timeoutMs=${limitMs ?? '?'}ms`
					: reason === 'job'
						? `超过 ${limitMs ?? '?'}ms 硬上限`
						: (task.signal?.reason ?? 'cancelled');
		controller.abort(detail);
		if (timer !== undefined) clearTimeout(timer);
	};
	const onAbort = () => {
		// 上游（job）中止：区分「调用级 / 硬上限」与「用户取消」，后者不是超时。
		const source = task.jobStops?.limit?.source;
		stopOnce(task.jobStops?.timedOut === true ? (source === 'call' ? 'call' : 'job') : undefined);
	};
	if (task.signal !== undefined) {
		if (task.signal.aborted) onAbort();
		else task.signal.addEventListener('abort', onAbort, { once: true });
	}
	if (typeof reviewer.timeoutMs === 'number' && reviewer.timeoutMs > 0) {
		timer = setTimeout(() => stopOnce('reviewer'), reviewer.timeoutMs);
		timer.unref?.();
	}
	const started = Date.now();
	// 报告标题里要能一眼看出这次到底是「哪个东西」在评审。
	// 标题里只放 basename：绝对路径（/Users/…/@openai/codex/bin/codex.js）又长又没用。
	const target =
		reviewer.kind === 'cli'
			? (reviewer.executable ?? reviewer.preset ?? 'cli').split('/').filter((part) => part.length > 0).pop() ?? 'cli'
			: `${reviewer.provider}${reviewer.agentModel === undefined ? '' : `/${reviewer.agentModel}`}`;
	try {
		const handler = reviewer.kind === 'subagent' ? runSubagent : runCli;
		const outcome = await handler(ctx, reviewer, task, { signal: controller.signal });
		return {
			id: reviewer.id,
			label: reviewer.label,
			kind: reviewer.kind,
			target,
			source: reviewer.source ?? 'config',
			status: outcome.status,
			detail: outcome.detail,
			diagnostics: outcome.diagnostics,
			// note 是给报告「材料说明」用的一句话（例如结论从 stdout 回退来的）。
			...(typeof outcome.note === 'string' && outcome.note.length > 0 ? { note: outcome.note } : {}),
			text: typeof outcome.text === 'string' ? outcome.text : '',
			elapsedMs: Date.now() - started,
			...(timedOut === undefined ? {} : { timedOut }),
			...(controller.signal.aborted && outcome.status !== 'completed' ? { detail: `${outcome.detail ?? '已中止'}（信号：${String(controller.signal.reason ?? 'cancelled')}）` } : {}),
		};
	} catch (error) {
		return { id: reviewer.id, label: reviewer.label, kind: reviewer.kind, target, source: reviewer.source ?? 'config', status: 'failed', detail: messageOf(error), text: '', elapsedMs: Date.now() - started, ...(timedOut === undefined ? {} : { timedOut }) };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		task.signal?.removeEventListener?.('abort', onAbort);
	}
}