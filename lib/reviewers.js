/**
 * 评审者执行器。
 *
 * 三种 kind 共用同一份输入（{@link ReviewTask}），各自把结论收敛成同一形状的
 * {@link ReviewOutcome}，所以上层编排不必知道对面是 CLI、模型还是子智能体：
 *
 * - `cli`：宿主侧 `ctx.subprocess` 起进程，argv 由模板展开，不经 shell；
 * - `llm`：走 DSH 自己的 `ctx.llm` 服务 —— 「让 dsh 调别的模型评审」就是这条；
 * - `subagent`：`ctx.subagents` 起一个只读子智能体，可以自己翻仓库。
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
	// codex 的 `review` 子命令里 PROMPT 与范围开关互斥：模板带 {promptArg} 就说明
	// 这个预设走原生语义，给了 PROMPT 时不能再带范围。
	const nativePrompt = template.includes('{promptArg}');
	const range = nativePrompt && promptText !== undefined ? [] : rangeArgs(target);

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

/* ────────────────────────────── CLI ────────────────────────────── */

/** codex / claude 这些 CLI 常装在 PATH 之外，按常见位置兜底找一遍。 */
async function resolveCliExecutable(ctx, reviewer, env, signal) {
	const name = reviewer.executable;
	if (typeof name !== 'string' || name.length === 0) {
		throw new Error(`评审者 ${reviewer.id} 没有配置 executable。`);
	}
	const candidates = [name];
	if (!name.includes('/')) {
		candidates.push(join(homedir(), '.local', 'bin', name), join(homedir(), '.bun', 'bin', name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`);
	}
	const tried = [];
	for (const candidate of candidates) {
		try {
			return { executable: await ctx.subprocess.resolveExecutable(candidate, env), candidate };
		} catch (error) {
			tried.push(`${candidate}（${messageOf(error)}）`);
		}
	}
	throw new Error(`找不到可执行文件 ${name}。可在该评审者的 config.executable 指定绝对路径。已尝试：${tried.join('；')}`);
}

async function runCli(ctx, reviewer, task, { signal }) {
	const env = {};
	for (const key of [...(task.settings.envPassthrough ?? []), ...(reviewer.envPassthrough ?? [])]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
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
	if (reviewer.capture === 'report') {
		try {
			text = await readFile(task.reportPath, 'utf8');
		} catch {
			text = '';
		}
	} else {
		text = stdout.text;
	}

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
	return { status: 'completed', detail: `\`${argv[0]}\` 退出码 0`, text };
}

/* ────────────────────────────── LLM ────────────────────────────── */

/**
 * 直接用 DSH 的 llm 服务调一个模型。
 *
 * 只消费自己需要的东西（text-delta + 终态 finish），不依赖 `dsh-llm` 的
 * BlockAssembler —— 这样插件保持零依赖，profile 里换版本也不会连坐。
 */
async function runLlm(ctx, reviewer, task, { signal }) {
	const llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm;
	if (llm === undefined || llm === null) {
		return { status: 'failed', detail: 'ctx.llm 服务不可用（需要 @deepseek-ai/dsh-llm 与至少一个 provider adapter）' };
	}

	const options = {
		provider: reviewer.provider,
		model: reviewer.model,
		system: task.brief.system,
		messages: [{ role: 'user', content: [{ type: 'text', text: task.brief.body }] }],
		signal,
	};
	if (reviewer.maxTokens !== undefined) options.maxTokens = reviewer.maxTokens;
	if (reviewer.temperature !== undefined) options.temperature = reviewer.temperature;

	let text = '';
	let failure;
	let finishKind;
	try {
		const stream = llm.stream(options);
		for await (const chunk of stream) {
			if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
			else if (chunk?.type === 'finish') {
				finishKind = chunk.reason?.kind;
				if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk.reason.failure;
			}
		}
	} catch (error) {
		return { status: 'failed', detail: `模型调用失败：${messageOf(error)}` };
	}

	if (failure !== undefined) {
		const code = typeof failure?.code === 'string' ? failure.code : undefined;
		const detail = typeof failure?.message === 'string' ? failure.message : undefined;
		return { status: 'failed', detail: `模型返回 ${finishKind}${code === undefined ? '' : `（${code}）`}${detail === undefined ? '' : `：${detail}`}`, text };
	}
	if (text.trim().length === 0) {
		return { status: 'failed', detail: `模型返回空结论${finishKind === undefined ? '' : `（finish: ${finishKind}）`}`, text: '' };
	}
	return { status: 'completed', detail: `${reviewer.provider}/${reviewer.model}${finishKind === 'max-tokens' ? '（输出被 max-tokens 截断）' : ''}`, text };
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

	const request = {
		label: `review:${reviewer.id}`,
		prompt: [{ type: 'text', text: `${task.brief.system}\n\n----- \n\n${task.brief.body}` }],
		parent: task.agent,
		signal,
		...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
		...(reviewer.persona === undefined ? {} : { persona: reviewer.persona }),
		...(reviewer.toolFilter === undefined ? {} : { toolFilter: reviewer.toolFilter }),
	};
	if (reviewer.maxDepth !== undefined && typeof subagents.resolveMaxDepth === 'function') {
		const depth = subagents.resolveMaxDepth(reviewer.maxDepth);
		if (depth !== undefined) request.maxDepth = depth;
	}

	let run;
	try {
		run = await subagents.start(reviewer.provider, request);
	} catch (error) {
		return { status: 'failed', detail: `启动子智能体失败：${messageOf(error)}` };
	}
	try {
		const result = await run.result;
		const text = joinContentBlocks(result?.output);
		if (result?.stopReason !== undefined && result.stopReason !== 'completed') {
			return { status: 'failed', detail: `子智能体结束原因 ${result.stopReason}${result.diagnostic === undefined ? '' : `：${result.diagnostic}`}`, text };
		}
		if (text.length === 0) return { status: 'failed', detail: '子智能体没有输出结论', text: '' };
		return { status: 'completed', detail: `provider ${reviewer.provider}${reviewer.agentModel === undefined ? '' : `, ${reviewer.agentProvider ?? ''}${reviewer.agentModel}`}`, text };
	} catch (error) {
		return { status: 'failed', detail: `子智能体运行失败：${messageOf(error)}` };
	} finally {
		try {
			await run.dispose?.();
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
	const onAbort = () => controller.abort(task.signal?.reason ?? 'cancelled');
	if (task.signal !== undefined) {
		if (task.signal.aborted) onAbort();
		else task.signal.addEventListener('abort', onAbort, { once: true });
	}
	let timer;
	if (typeof reviewer.timeoutMs === 'number' && reviewer.timeoutMs > 0) {
		timer = setTimeout(() => controller.abort(`超过 ${reviewer.timeoutMs}ms`), reviewer.timeoutMs);
		timer.unref?.();
	}
	const started = Date.now();
	// 报告标题里要能一眼看出这次到底是「哪个东西」在评审。
	const target =
		reviewer.kind === 'llm'
			? `${reviewer.provider}/${reviewer.model}`
			: reviewer.kind === 'cli'
				? (reviewer.executable ?? '')
				: `${reviewer.provider}${reviewer.agentModel === undefined ? '' : `/${reviewer.agentModel}`}`;
	try {
		const handler = reviewer.kind === 'llm' ? runLlm : reviewer.kind === 'subagent' ? runSubagent : runCli;
		const outcome = await handler(ctx, reviewer, task, { signal: controller.signal });
		return {
			id: reviewer.id,
			label: reviewer.label,
			kind: reviewer.kind,
			target,
			status: outcome.status,
			detail: outcome.detail,
			diagnostics: outcome.diagnostics,
			text: typeof outcome.text === 'string' ? outcome.text : '',
			elapsedMs: Date.now() - started,
			...(controller.signal.aborted && outcome.status !== 'completed' ? { detail: `${outcome.detail ?? '已中止'}（信号：${String(controller.signal.reason ?? 'cancelled')}）` } : {}),
		};
	} catch (error) {
		return { id: reviewer.id, label: reviewer.label, kind: reviewer.kind, target, status: 'failed', detail: messageOf(error), text: '', elapsedMs: Date.now() - started };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		task.signal?.removeEventListener?.('abort', onAbort);
	}
}