/**
 * 运行：node selftest.mjs
 *
 * 假 ctx 自测：不起宿主进程，也不跑真的 codex / 模型。覆盖
 *
 * - 配置归一化（agents / models / reviewers 展开、非法项降级、模式解析、评审者选择）；
 * - 三种评审者：CLI（argv 拼装 + 结论落盘）、LLM（ctx.llm 流式）、子智能体（ctx.subagents）；
 * - 变更收集：git 摘要、diff 包按需收集、未跟踪文件正文；
 * - 编排：就地返回 / 后台返回 / 纯后台 / 失败收敛 / 汇总 / 截断 / 系统提示词注入。
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLUGIN = new URL('./index.js', import.meta.url).href;

/* ────────────────────────────── 假 ctx ────────────────────────────── */

/** 默认 git 脚本：一个已修改文件 + 一个未跟踪新文件。 */
function defaultGitScript(cwd) {
	return [
		{ argv: ['git', 'rev-parse', '--is-inside-work-tree'], stdout: 'true\n' },
		{ argv: ['git', 'rev-parse', '--show-toplevel'], stdout: `${cwd}\n` },
		{ argv: ['git', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '-uall'], stdout: ' M src/a.js\0?? src/b.js\0' },
		{ argv: ['git', '-c', 'core.quotepath=false', 'diff', '--numstat'], stdout: '10\t2\tsrc/a.js\n' },
		{ argv: ['git', '-c', 'core.quotepath=false', 'diff', '--cached', '--numstat'], stdout: '' },
		{ argv: ['git', '-c', 'core.quotepath=false', 'diff', '--stat'], stdout: ' src/a.js | 12 ++++++++----\n 1 file changed, 10 insertions(+), 2 deletions(-)\n' },
		{ argv: ['git', '-c', 'core.quotepath=false', 'diff', '--cached', '--stat'], stdout: '' },
		{ argv: ['git', '-c', 'core.quotepath=false', 'diff', '--no-color'], stdout: 'diff --git a/src/a.js b/src/a.js\nindex 111..222 100644\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n' },
		{ argv: ['git', '-c', 'core.quotepath=false', 'diff', '--cached', '--no-color'], stdout: '' },
		{ argv: ['git', '-c', 'core.quotepath=false', 'diff', '--numstat', 'main'], stdout: '3\t1\tsrc/c.js\n' },
		{ argv: ['git', '-c', 'core.quotepath=false', 'diff', '--stat', 'main'], stdout: ' src/c.js | 4 +++-\n' },
		{ argv: ['git', '-c', 'core.quotepath=false', 'diff', '--no-color', '--find-renames', 'main'], stdout: 'diff --git a/src/c.js b/src/c.js\n@@ -1 +1 @@\n-x\n+y\n' },
		{ argv: ['git', '-c', 'core.quotepath=false', 'show', '--numstat', '--format=', 'abc123'], stdout: '1\t1\tsrc/d.js\n' },
		{ argv: ['git', '-c', 'core.quotepath=false', 'show', '--stat', '--format=%h %s', 'abc123'], stdout: 'abc123 fix: thing\n src/d.js | 2 +-\n' },
		{ argv: ['git', '-c', 'core.quotepath=false', 'show', '--patch', '--no-color', '--format=medium', 'abc123'], stdout: 'commit abc123\n\ndiff --git a/src/d.js b/src/d.js\n@@ -1 +1 @@\n-p\n+q\n' },
	];
}

function makeHarness(options = {}) {
	const cwd = options.cwd ?? process.cwd();
	const state = {
		tool: undefined,
		jobs: new Map(),
		counter: 0,
		spawns: [],
		waits: [],
		llmCalls: [],
		subagentCalls: [],
		sections: [],
		disposed: 0,
	};
	const script = options.gitScript ?? defaultGitScript(cwd);
	const wait = options.wait ?? 'settle';

	const spawn = (spec) => {
		state.spawns.push(spec);
		const matched = script.find((entry) => JSON.stringify(entry.argv) === JSON.stringify(spec.argv));
		const stdout = matched?.stdout ?? options.stdout ?? '';
		const stderr = matched?.stderr ?? options.stderr ?? '';
		const exitCode = matched?.exitCode ?? options.exitCode ?? 0;
		// `--output-last-message <path>`：CLI 把结论写进文件。
		const reportFlag = spec.argv.indexOf('--output-last-message');
		const reportPath = reportFlag >= 0 ? spec.argv[reportFlag + 1] : undefined;
		if (reportPath !== undefined && options.report !== undefined) writeFileSync(reportPath, options.report);
		const reader = (text) => ({ readFrom: () => ({ text, lossy: false, nextOffset: text.length, spillPath: `/spill/${text.length}` }) });
		return {
			collected: { stdout: reader(stdout), stderr: reader(stderr) },
			done: Promise.resolve({ exitCode, signal: null }),
			terminate() {},
		};
	};

	const ctx = {
		tools: {
			register(definition) {
				state.tool = definition;
				return () => {
					state.tool = undefined;
				};
			},
		},
		effect(fn) {
			const dispose = fn();
			state.dispose = dispose;
			return dispose;
		},
		get(serviceName) {
			return options.services?.[serviceName];
		},
		subprocess: {
			async resolveExecutable(command) {
				if (command.includes('no-such')) throw new Error('not found');
				if (command.includes('/')) return command;
				return `/fake/${command}`;
			},
			spawn,
		},
		jobs: {
			start(spec) {
				const id = `review-${++state.counter}`;
				const record = { id, kind: spec.kind, label: spec.label, chunks: [], status: 'running', detail: undefined, progress: undefined };
				const handle = {
					id,
					append(text, opts) {
						record.chunks.push({ text, channel: opts?.channel });
					},
					updateProgress(line) {
						record.progress = line;
					},
				};
				const hooks = spec.run(handle);
				record.hooks = hooks;
				record.settledPromise = hooks.done.then((outcome) => {
					record.status = outcome.status;
					record.detail = outcome.detail;
					return outcome;
				});
				state.jobs.set(id, record);
				return id;
			},
			async wait(id, timeoutMs) {
				state.waits.push(timeoutMs);
				const record = state.jobs.get(id);
				if (wait === 'running') return { status: 'running' };
				await record.settledPromise;
				return { status: record.status, ...(record.detail === undefined ? {} : { detail: record.detail }) };
			},
			read(id) {
				const record = state.jobs.get(id);
				return { chunks: record.chunks, lossy: false, job: { output: { spillPaths: [] } } };
			},
			remove(id) {
				state.jobs.delete(id);
			},
			kill(id, owner, reason) {
				state.jobs.get(id)?.hooks.cancel(reason);
			},
		},
	};

	return { ctx, state, cwd };
}

async function loadPlugin({ plugin, harness = {}, services } = {}) {
	const built = makeHarness({ ...harness, services: services ?? harness.services });
	const mod = await import(PLUGIN);
	mod.apply(built.ctx, plugin ?? {});
	return { ...built, definition: built.state.tool, mod };
}

/** 跑一次工具并等它结算（默认 harness 会等 job 跑完）。 */
async function run(harness, args = {}, exec = defaultExec(harness.cwd)) {
	return harness.definition.execute(args, exec);
}

function defaultExec(cwd) {
	return { agent: { id: 'agent-1', session: { header: { cwd } } }, signal: new AbortController().signal };
}

/* ────────────────────────────── 断言 ────────────────────────────── */

let failures = 0;
let passes = 0;
function check(name, condition, detail) {
	if (condition) {
		passes += 1;
		console.log(`  ok   ${name}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

async function rejects(name, fn) {
	try {
		await fn();
		check(name, false, '没有抛错');
	} catch (error) {
		check(name, true, undefined);
		return error;
	}
	return undefined;
}

/* ────────────────────────────── 临时工作区 ────────────────────────────── */

const WORK = mkdtempSync(join(tmpdir(), 'dsh-review-selftest-'));
mkdirSync(join(WORK, 'src'), { recursive: true });
writeFileSync(join(WORK, 'src', 'b.js'), 'export const b = 2;\n');
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }));

const GIT = { cwd: WORK };

/* ────────────────────────────── A. 配置归一化 ────────────────────────────── */

console.log('\nA. 配置归一化');
{
	const { resolveSettings, selectReviewers, resolveMode } = await import(new URL('./lib/settings.js', import.meta.url).href);
	const settings = resolveSettings({
		agents: [{ preset: 'codex', model: 'gpt-x' }, { preset: 'claude' }],
		models: [
			{ provider: 'bainian', model: 'qwen3.8-max', label: 'Qwen' },
			{ provider: 'bainian', model: 'glm-5.3' },
		],
		reviewers: [{ id: 'deep', subagentProvider: 'spawn', agentProvider: 'bainian', agentModel: 'deepseek-v4.1-flash' }],
		defaultReviewers: ['codex', 'nope'],
		modes: {
			quick: { strength: 'light', reviewers: ['qwen3.8-max'], prompt: '只看阻塞问题' },
			strict: { strength: 'deep', reviewers: ['codex', 'qwen3.8-max'], synthesize: true, when: 'complex', minChangedLines: 50 },
			broken: { strength: 'nonsense' },
		},
		defaultMode: 'strict',
	});
	const ids = settings.reviewers.map((reviewer) => reviewer.id);
	check('A agents 展开成 cli', settings.reviewers.filter((r) => r.kind === 'cli').map((r) => r.id).join(',') === 'codex,claude', ids.join(','));
	check('A models 展开成 llm', settings.reviewers.find((r) => r.id === 'qwen3.8-max')?.kind === 'llm');
	check('A reviewers 里的 subagent 推断出 kind', settings.reviewers.find((r) => r.id === 'deep')?.kind === 'subagent');
	check('A 未知 defaultReviewers 被过滤', settings.defaultReviewers.join(',') === 'codex');
	check('A 未知 strength 降级为 standard', settings.modes.broken?.strength === 'standard');
	check('A 未知 strength 有告警', settings.warnings.some((w) => w.includes('nonsense')));
	check('A defaultMode 生效', settings.defaultMode === 'strict');
	check('A resolveMode 默认模式', resolveMode(settings).name === 'strict');
	const selected = selectReviewers(settings, settings.modes.quick, undefined);
	check('A 模式指定评审者优先', selected.map((r) => r.id).join(',') === 'qwen3.8-max', selected.map((r) => r.id).join(','));
	check('A 调用方指定评审者最高优先', selectReviewers(settings, settings.modes.quick, ['codex']).map((r) => r.id).join(',') === 'codex');
	await rejects('A 未知模式报错', () => resolveMode(settings, 'nope'));
	await rejects('A 未知评审者报错', () => selectReviewers(settings, undefined, ['ghost']));

	const bad = resolveSettings({ reviewers: [{ id: 'x', kind: 'llm' }, { kind: 'cli' }, { id: 'y', kind: 'nope' }] });
	check('A 非法评审者被丢弃', bad.reviewers.length === 0 && bad.warnings.length === 3, `${bad.reviewers.length}/${bad.warnings.length}`);
	await rejects('A 没有评审者时报错清晰', () => selectReviewers(bad, undefined, undefined));
}

/* ────────────────────────────── B. 工具描述与参数校验 ────────────────────────────── */

console.log('\nB. 工具描述与参数校验');
{
	const h = await loadPlugin({
		plugin: {
			agents: [{ preset: 'codex' }],
			models: [{ provider: 'bainian', model: 'qwen3.8-max' }],
			modes: { deep: { strength: 'deep', description: '彻底评审' } },
		},
	});
	check('B 工具名是 review', h.definition.name === 'review', h.definition.name);
	const description = h.definition.description;
	check('B 描述列出评审者', description.includes('`codex`') && description.includes('`qwen3.8-max`'));
	check('B 描述列出模式', description.includes('`deep`') && description.includes('彻底评审'));
	check('B 描述强调 base/commit 与 instructions 互斥', description.includes('互斥'));
	check('B 参数含 reviewers/mode/base/commit/instructions', Object.keys(h.definition.parameters.properties).join(',') === 'reviewers,mode,base,commit,instructions');
	check('B presentCall 是 terminal 卡片', h.definition.presentCall({ reviewers: ['codex'], base: 'main' }).title === 'review(codex) --base main');

	await rejects('B 拒绝 base+commit', () => run(h, { base: 'main', commit: 'abc' }));
	await rejects('B 拒绝 base+instructions', () => run(h, { base: 'main', instructions: 'x' }));
	await rejects('B 拒绝 instructions=-', () => run(h, { instructions: '-' }));
	await rejects('B 拒绝超长 base', () => run(h, { base: 'a'.repeat(300) }));
	await rejects('B 拒绝以 - 开头的 base（会被 git 当开关）', () => run(h, { base: '--cached' }));
	await rejects('B 拒绝以 - 开头的 commit', () => run(h, { commit: '--all' }));
	await rejects('B 拒绝 reviewers 非数组', () => run(h, { reviewers: 'codex' }));
	await rejects('B 拒绝未知模式', () => run(h, { mode: 'ghost' }));
	await rejects('B 拒绝未知评审者', () => run(h, { reviewers: ['ghost'] }));
}

/* ────────────────────────────── C. CLI 评审者（codex 预设） ────────────────────────────── */

console.log('\nC. CLI 评审者');
{
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex', model: 'gpt-x' }] }, harness: { ...GIT, report: '# 评审结论\n\n发现一个 P2 问题。' } });
	const value = await run(h, {});
	check('C kind=completed', value.kind === 'completed', JSON.stringify(value).slice(0, 160));
	check('C 结论来自 --output-last-message 文件', value.report.includes('发现一个 P2 问题'));
	check('C 报告含评审范围头', value.report.includes('## 评审范围') && value.report.includes('未提交的改动'));
	check('C 报告含变更规模', value.report.includes('+10 / -2'), value.report.slice(0, 400));
	const argv = h.state.spawns.find((spec) => spec.argv[0] === '/fake/codex').argv;
	check('C argv 前缀', JSON.stringify(argv.slice(0, 7)) === JSON.stringify(['/fake/codex', 'exec', 'review', '--uncommitted', '--ephemeral', '-m', 'gpt-x']), JSON.stringify(argv.slice(0, 8)));
	check('C argv 带 --output-last-message', argv.includes('--output-last-message'));
	check('C codex 不喂 diff（needsPacket=false）', !h.state.spawns.some((spec) => spec.argv.includes('--no-color') && spec.argv.includes('diff')), JSON.stringify(h.state.spawns.map((s) => s.argv.slice(0, 5))));
	check('C ring 里就是报告', h.state.jobs.get('review-1') === undefined, '就地返回后 job 应被移除');
}
{
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, report: '结论' } });
	const value = await run(h, { base: 'main' });
	const argv = h.state.spawns.find((spec) => spec.argv[0] === '/fake/codex').argv;
	check('C --base 生效', argv.includes('--base') && argv.includes('main'), JSON.stringify(argv.slice(0, 8)));
	check('C --base 的报告头正确', value.report.includes('相对 main 的改动'), value.report.slice(0, 200));
	const notBase = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, report: '结论' } });
	await run(notBase, { commit: 'abc123' });
	check('C --commit 生效', notBase.state.spawns.find((spec) => spec.argv[0] === '/fake/codex').argv.includes('abc123'));
}
{
	// 自定义指令走 codex 的 PROMPT 位置：不带范围开关，`--` 终止符兜住以 `-` 开头的指令。
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, report: '结论' } });
	await run(h, { instructions: '--focus on concurrency' });
	const argv = h.state.spawns.find((spec) => spec.argv[0] === '/fake/codex').argv;
	check('C 有 PROMPT 时不带范围开关', !argv.some((token) => ['--uncommitted', '--base', '--commit'].includes(token)), JSON.stringify(argv));
	check('C PROMPT 前有 -- 终止符', argv.at(-2) === '--' && argv.at(-1) === '--focus on concurrency', JSON.stringify(argv.slice(-3)));
}
{
	// 模式提示词也走 PROMPT，与 instructions 合并。
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }], modes: { focus: { prompt: '只关注并发' } } },
		harness: { ...GIT, report: '结论' },
	});
	await run(h, { mode: 'focus', instructions: '忽略注释' });
	const argv = h.state.spawns.find((spec) => spec.argv[0] === '/fake/codex').argv;
	check('C 模式提示词进 PROMPT', argv.at(-1).includes('只关注并发') && argv.at(-1).includes('忽略注释'), argv.at(-1));
}
{
	// claude 预设：走 stdout capture，评审包里有 diff。
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'claude', model: 'sonnet' }] }, harness: { ...GIT, stdout: 'Claude 的结论：没问题。' } });
	const value = await run(h, {});
	const spec = h.state.spawns.find((entry) => entry.argv[0] === '/fake/claude');
	check('C claude argv 用 --print', spec.argv.includes('--print') && spec.argv.includes('--model') && spec.argv.includes('sonnet'), JSON.stringify(spec.argv.slice(0, 6)));
	const promptArg = spec.argv.at(-1);
	check('C claude 收到 diff 包', promptArg.includes('const a = 2') && promptArg.includes('未跟踪的新文件'), promptArg.slice(0, 200));
	check('C claude 结论来自 stdout', value.report.includes('没问题'));
}
{
	// custom 预设：argv 模板 + stdin 投递。
	const h = await loadPlugin({
		plugin: { reviewers: [{ id: 'my', kind: 'cli', command: ['{exe}', '--json', '{model}', '{extra}'], executable: 'myreview', promptVia: 'stdin', capture: 'stdout', model: 'm1', extraArgs: ['--strict'] }] },
		harness: { ...GIT, stdout: '自定义结论' },
	});
	const value = await run(h, {});
	const spec = h.state.spawns.find((entry) => entry.argv[0] === '/fake/myreview');
	check('C custom argv 展开', JSON.stringify(spec.argv) === JSON.stringify(['/fake/myreview', '--json', '--model', 'm1', '--strict']), JSON.stringify(spec.argv));
	check('C custom stdin 投递', typeof spec.stdio.stdin === 'object' && spec.stdio.stdin.data.includes('评审任务'), JSON.stringify(spec.stdio.stdin).slice(0, 80));
	check('C custom 结论', value.report.includes('自定义结论'));
}
{
	// 失败：状态行 + 诊断输出，但不出错。
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, exitCode: 1, stderr: 'stream error: not logged in', report: '' } });
	const value = await run(h, {});
	check('C 失败仍是 completed 的工具结果', value.kind === 'completed');
	check('C 失败有状态徽标', value.report.includes('**失败**') && value.report.includes('退出码 1'), value.report.slice(0, 400));
	check('C 失败带诊断输出', value.report.includes('not logged in'));
}
{
	const h = await loadPlugin({
		plugin: { reviewers: [{ id: 'ghostbin', kind: 'cli', preset: 'custom', executable: 'no-such-bin-xyz', command: ['{exe}', '{prompt}'] }] },
		harness: { ...GIT },
	});
	const value = await run(h, {});
	check('C 找不到可执行文件时报告里写明', value.report.includes('找不到可执行文件') && value.report.includes('no-such-bin-xyz'), value.report.slice(0, 400));
}

/* ────────────────────────────── D. LLM 评审者 ────────────────────────────── */

console.log('\nD. LLM 评审者');
{
	const llmCalls = [];
	const services = {
		llm: {
			stream(options) {
				llmCalls.push(options);
				return (async function* stream() {
					yield { type: 'block-start', index: 0, blockType: 'text' };
					yield { type: 'text-delta', index: 0, text: '[P1] src/a.js:1 — 空指针 — 加判空' };
					yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
					yield { type: 'finish', reason: { kind: 'stop' } };
				})();
			},
		},
	};
	const h = await loadPlugin({
		plugin: { models: [{ provider: 'bainian', model: 'qwen3.8-max', label: 'Qwen', llm: { maxTokens: 4096, temperature: 0 } }] },
		harness: { ...GIT, services },
	});
	const value = await run(h, {});
	check('D 结论进报告', value.report.includes('[P1] src/a.js:1'), value.report.slice(0, 300));
	check('D 报告标注 provider/model', value.report.includes('bainian/qwen3.8-max'));
	check('D 调用了 ctx.llm', llmCalls.length === 1 && llmCalls[0].provider === 'bainian' && llmCalls[0].model === 'qwen3.8-max');
	check('D 传了 system 与 user 消息', typeof llmCalls[0].system === 'string' && llmCalls[0].messages[0].content[0].type === 'text');
	check('D 传了 maxTokens/temperature', llmCalls[0].maxTokens === 4096 && llmCalls[0].temperature === 0);
	check('D 消息里带 diff 包', llmCalls[0].messages[0].content[0].text.includes('const a = 2'));
	check('D 消息里带未跟踪文件', llmCalls[0].messages[0].content[0].text.includes('export const b = 2;'));
	check('D 语音按中文提示词', llmCalls[0].system.includes('资深代码评审者'));
}
{
	const services = {
		llm: {
			*stream() {
				yield { type: 'text-delta', index: 0, text: '' };
				yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } };
			},
		},
	};
	const h = await loadPlugin({ plugin: { models: [{ provider: 'bainian', model: 'glm-5.3' }] }, harness: { ...GIT, services } });
	const value = await run(h, {});
	check('D 模型失败被收敛', value.report.includes('**失败**') && value.report.includes('AUTH'), value.report.slice(0, 300));
}
{
	// 没有 llm 服务：报告里说明，而不是抛给上层。
	const h = await loadPlugin({ plugin: { models: [{ provider: 'bainian', model: 'glm-5.3' }] }, harness: { ...GIT } });
	const value = await run(h, {});
	check('D 缺 ctx.llm 时给出说明', value.report.includes('ctx.llm 服务不可用'), value.report.slice(0, 300));
}
{
	// 模式的强度短语与 prompt 都要进 llm 的 system 槽。
	const calls = [];
	const services = { llm: { stream(options) { calls.push(options); return (async function* stream() { yield { type: 'text-delta', index: 0, text: '结论' }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } } };
	const h = await loadPlugin({
		plugin: {
			models: [{ provider: 'bainian', model: 'qwen3.8-max' }],
			modes: { strict: { strength: 'deep', prompt: '只关注错误处理', reviewers: ['qwen3.8-max'] } },
			defaultMode: 'strict',
		},
		harness: { ...GIT, services },
	});
	await run(h, {});
	check('D 模式强度写进 system', calls[0].system.includes('深度评审') && calls[0].system.includes('只关注错误处理'), calls[0].system.slice(0, 200));
	check('D 模式信息进 user 消息', calls[0].messages[0].content[0].text.includes('评审模式：`strict`（deep）'));
	check('D 模式 prompt 不泄漏到 codex 之外的评审者', !calls[0].messages[0].content[0].text.includes('### 本次评审强度'));
}

/* ────────────────────────────── E. 子智能体评审者 ────────────────────────────── */

console.log('\nE. 子智能体评审者');
{
	const subagentCalls = [];
	const services = {
		subagents: {
			getProvider: (name) => (name === 'spawn' ? { name: 'spawn' } : undefined),
			resolveMaxDepth: (depth) => depth,
			async start(name, request) {
				subagentCalls.push({ name, request });
				return {
					result: Promise.resolve({ output: [{ type: 'text', text: '子智能体结论：没发现问题。' }], stopReason: 'completed' }),
					dispose: async () => {},
				};
			},
		},
	};
	const h = await loadPlugin({
		plugin: { reviewers: [{ id: 'deep', kind: 'subagent', provider: 'spawn', agentProvider: 'bainian', agentModel: 'deepseek-v4.1-flash', maxDepth: 1, persona: '你是评审者' }] },
		harness: { ...GIT, services },
	});
	const value = await run(h, {});
	check('E 子智能体结论进报告', value.report.includes('子智能体结论'), value.report.slice(0, 300));
	check('E 传了 provider 与 model', subagentCalls[0].request.agentOptions.provider === 'bainian' && subagentCalls[0].request.agentOptions.model === 'deepseek-v4.1-flash');
	check('E 传了 parent 与 persona', subagentCalls[0].request.parent.id === 'agent-1' && subagentCalls[0].request.persona === '你是评审者');
	check('E 提示词里有评审包', subagentCalls[0].request.prompt[0].text.includes('评审任务'));
}
{
	const h = await loadPlugin({ plugin: { reviewers: [{ id: 'deep', kind: 'subagent' }] }, harness: { ...GIT } });
	const value = await run(h, {});
	check('E 缺 ctx.subagents 时给出说明', value.report.includes('ctx.subagents 服务不可用'));
}

/* ────────────────────────────── F. 编排 ────────────────────────────── */

console.log('\nF. 编排');
{
	const services = { llm: { *stream() { yield { type: 'text-delta', index: 0, text: 'LLM 结论' }; yield { type: 'finish', reason: { kind: 'stop' } }; } } };
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }], models: [{ provider: 'bainian', model: 'qwen3.8-max' }] },
		harness: { ...GIT, report: 'Codex 结论', services },
	});
	const value = await run(h, {});
	check('F 多评审者都出现', value.report.includes('Codex 结论') && value.report.includes('LLM 结论'));
	check('F reviewers 字段回填', value.reviewers.join(',') === 'codex,qwen3.8-max', JSON.stringify(value.reviewers));
	check('F status=completed', value.status === 'completed', value.detail);
	check('F job 已移除', h.state.jobs.size === 0);
}
{
	// 后台返回：先拿 job id，环里最终是报告。
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, wait: 'running', report: '后台结论' } });
	const value = await run(h, {});
	check('F kind=running', value.kind === 'running' && value.jobId === 'review-1', JSON.stringify(value));
	const record = h.state.jobs.get('review-1');
	await record.settledPromise;
	const ring = record.chunks.map((chunk) => chunk.text).join('');
	check('F ring 里是报告', ring.includes('后台结论') && ring.includes('## 评审范围'));
	check('F progress 行已设置', record.progress === 'reviewing (codex)', record.progress);
}
{
	// waitMs=0：纯后台，不发起等待。
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }], waitMs: 0 }, harness: { ...GIT, report: 'x' } });
	const value = await run(h, {});
	check('F waitMs=0 直接交回 job id', value.kind === 'running' && value.jobId === 'review-1');
	check('F waitMs=0 没有发起等待', h.state.waits.length === 0, JSON.stringify(h.state.waits));
}
{
	// 一个评审者失败不影响另一个。
	const services = { llm: { *stream() { yield { type: 'text-delta', index: 0, text: 'LLM 结论' }; yield { type: 'finish', reason: { kind: 'stop' } }; } } };
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }, { preset: 'gemini' }], models: [{ provider: 'bainian', model: 'qwen3.8-max' }] },
		harness: {
			...GIT,
			report: 'Codex 结论',
			services,
			gitScript: defaultGitScript(WORK),
		},
	});
	// gemini 用 stdout capture，返回空 → failed。
	const value = await run(h, {});
	check('F 部分失败仍是 completed', value.kind === 'completed' && value.status === 'completed', JSON.stringify(value).slice(0, 200));
	check('F 报告里有失败者', value.report.includes('**失败**') && value.report.includes('没有输出结论'), value.report.slice(0, 400));
}
{
	// 全部失败 → status=failed，但工具本身仍然返回报告。
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, exitCode: 2, stderr: 'boom', report: '' } });
	const value = await run(h, {});
	check('F 全失败时 status=failed', value.status === 'failed', value.status);
	check('F 全失败时仍有报告', value.report.includes('boom'));
}
{
	// 深评审汇总：合成一次额外 llm 调用。
	const calls = [];
	const services = {
		llm: {
			stream(options) {
				calls.push(options);
				const text = calls.length === 1 ? '评审者 A 的结论' : '汇总后的结论';
				return (async function* stream() {
					yield { type: 'text-delta', index: 0, text };
					yield { type: 'finish', reason: { kind: 'stop' } };
				})();
			},
		},
	};
	const h = await loadPlugin({
		plugin: {
			models: [
				{ provider: 'bainian', model: 'qwen3.8-max' },
				{ provider: 'bainian', model: 'glm-5.3' },
			],
			modes: { deep: { strength: 'deep', synthesize: true } },
			defaultMode: 'deep',
		},
		harness: { ...GIT, services },
	});
	const value = await run(h, {});
	check('F 汇总调用发生', calls.length === 3, `${calls.length}`);
	check('F 汇总结论进报告', value.report.includes('汇总后的结论') && value.report.includes('汇总（评审结论合并）'), value.report.slice(-400));
}
{
	// 截断：完整报告落盘，结果里给出路径。
	const long = 'x'.repeat(4000);
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }], maxResultChars: 500 }, harness: { ...GIT, report: long } });
	const value = await run(h, {});
	check('F 截断提示', value.report.includes('报告已截断') && value.report.includes('完整报告：'), value.report.slice(-200));
	check('F 完整报告可读', (() => {
		const match = value.report.match(/完整报告：(\S+?)\]/);
		return match !== null && readFileSync(match[1], 'utf8').length > 500;
	})());
}
{
	// 系统提示词注入：默认关闭；打开后才注册 section。
	const makePrompt = () => ({ sections: [], section(section) { this.sections.push(section); return () => {}; }, getSectionOrder: () => 2900 });
	const off = makePrompt();
	await loadPlugin({ plugin: { modes: { strict: { when: 'always' } } }, services: { systemPrompt: off }, harness: {} });
	check('F 默认不注入策略', off.sections.length === 0);
	const on = makePrompt();
	await loadPlugin({ plugin: { injectPolicy: true, modes: { strict: { when: 'always' } } }, services: { systemPrompt: on }, harness: {} });
	check('F injectPolicy 打开后注册 section', on.sections.length === 1 && on.sections[0].name === 'review:policy', JSON.stringify(on.sections));
	check('F 策略文本说明强制评审', on.sections[0].text.includes('任何改动都必须经过') && on.sections[0].text.includes('review'));
	check('F section 顺序在工具区之前', on.sections[0].order === 2899, String(on.sections[0].order));
}

/* ────────────────────────────── G. 非 git 目录 / 空改动 ────────────────────────────── */

console.log('\nG. 边界');
{
	const h = await loadPlugin({
		plugin: { models: [{ provider: 'bainian', model: 'qwen3.8-max' }] },
		harness: { ...GIT, gitScript: [{ argv: ['git', 'rev-parse', '--is-inside-work-tree'], exitCode: 128, stderr: 'not a git repository' }], services: { llm: { *stream() { yield { type: 'text-delta', index: 0, text: '结论' }; yield { type: 'finish', reason: { kind: 'stop' } }; } } } },
	});
	const value = await run(h, {});
	check('G 非 git 目录有说明', value.report.includes('不是 git 仓库'), value.report.slice(0, 300));
	check('G 非 git 目录仍能评审', value.report.includes('结论'));
}
{
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }], defaultReviewers: ['codex'] },
		harness: { ...GIT, report: '结论' },
	});
	const value = await run(h, {});
	check('G defaultReviewers 生效', value.reviewers.join(',') === 'codex');
}
{
	// 干净工作区：不打扰评审者，直接给结论。
	const clean = [
		{ argv: ['git', 'rev-parse', '--is-inside-work-tree'], stdout: 'true\n' },
		{ argv: ['git', 'rev-parse', '--show-toplevel'], stdout: `${WORK}\n` },
		{ argv: ['git', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '-uall'], stdout: '' },
	];
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }], models: [{ provider: 'bainian', model: 'qwen3.8-max' }] }, harness: { ...GIT, gitScript: clean, report: '结论' } });
	const value = await run(h, {});
	check('G 无改动时短路', value.report.includes('未检测到需要评审的改动') && !value.report.includes('结论'), value.report.slice(0, 300));
	check('G 无改动时不调评审者', !h.state.spawns.some((spec) => spec.argv[0] === '/fake/codex'));
}
{
	const { resolveSettings } = await import(new URL('./lib/settings.js', import.meta.url).href);
	const settings = resolveSettings({ agents: [{ preset: 'codex' }, { preset: 'codex', model: 'other' }] });
	check('G 重复 id 有告警', settings.reviewers.length === 1 && settings.warnings.some((w) => w.includes('重复')), settings.warnings.join('|'));
}
{
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }, { preset: 'claude' }], defaultReviewers: ['codex'] }, harness: { ...GIT, report: '结论', stdout: '结论' } });
	const value = await run(h, {});
	check('G 只跑默认评审者', value.reviewers.join(',') === 'codex', value.reviewers.join(','));
	const both = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }, { preset: 'claude' }] }, harness: { ...GIT, report: '结论', stdout: '结论' } });
	const value2 = await run(both, {});
	check('G 不传则跑全部启用', value2.reviewers.join(',') === 'codex,claude', value2.reviewers.join(','));
}

/* ────────────────────────────── H. 回归（真实评审发现的问题） ────────────────────────────── */

console.log('\nH. 回归');
{
	// 未跟踪目录要用 -uall 展开成文件，并且路径按仓库根解析（不是 cwd）。
	const statusArgv = h => h.state.spawns.filter((spec) => spec.argv.includes('status')).map((spec) => spec.argv.join(' '));
	const calls = [];
	const h = await loadPlugin({
		plugin: { models: [{ provider: 'bainian', model: 'qwen3.8-max' }] },
		harness: { ...GIT, services: { llm: { stream(options) { calls.push(options); return (async function* stream() { yield { type: 'text-delta', index: 0, text: '结论' }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } } } },
	});
	await run(h, {});
	check('H status 用 -uall', statusArgv(h).some((argv) => argv.includes('-uall')), statusArgv(h).join('|'));
	check('H 解析仓库根', h.state.spawns.some((spec) => spec.argv.join(' ') === 'git rev-parse --show-toplevel'));
	check('H 未跟踪文件按仓库根路径读到正文', calls[0].messages[0].content[0].text.includes('export const b = 2;'), calls[0].messages[0].content[0].text.slice(-400));
}
{
	// 两个 capture: report 的评审者，id 洗过之后同名，也不能互相覆盖结论文件。
	const seen = [];
	const h = await loadPlugin({
		plugin: {
			reviewers: [
				{ id: 'a/b', kind: 'cli', preset: 'codex' },
				{ id: 'a-b', kind: 'cli', preset: 'codex' },
			],
		},
		harness: { ...GIT, report: '报告内容' },
	});
	await run(h, {});
	const reportFlags = h.state.spawns.filter((spec) => spec.argv.includes('--output-last-message')).map((spec) => spec.argv[spec.argv.indexOf('--output-last-message') + 1]);
	seen.push(...reportFlags);
	check('H 两个评审者文件名不同', new Set(reportFlags).size === 2, reportFlags.join(', '));
}
{
	// 被禁用的 llm 评审者不该被选来汇总。
	const calls = [];
	const services = { llm: { stream(options) { calls.push(options); return (async function* stream() { yield { type: 'text-delta', index: 0, text: 'x' }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } } };
	const h = await loadPlugin({
		plugin: {
			reviewers: [
				{ id: 'dis', kind: 'llm', provider: 'bainian', model: 'glm-5.3', enabled: false },
				{ id: 'on', kind: 'llm', provider: 'bainian', model: 'qwen3.8-max' },
			],
			modes: { deep: { synthesize: true, synthesizeReviewer: 'dis' } },
			defaultMode: 'deep',
		},
		harness: { ...GIT, services },
	});
	await run(h, {});
	check('H 汇总不用被禁用的评审者', calls.every((call) => call.model !== 'glm-5.3'), JSON.stringify(calls.map((call) => call.model)));
}
{
	// 未截断时清掉临时目录；截断时保留（结果里引用了路径）。
	const { readdirSync } = await import('node:fs');
	const count = () => readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-review-')).length;
	const before = count();
	const short = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, report: '短结论' } });
	await run(short, {});
	const afterShort = count();
	check('H 未截断时临时目录被清理', afterShort === before, `${before} → ${afterShort}`);
	const long = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }], maxResultChars: 100 }, harness: { ...GIT, report: 'y'.repeat(3000) } });
	const value = await run(long, {});
	const afterLong = count();
	check('H 截断时临时目录保留并可读', afterLong === before + 1 && value.report.includes('完整报告：'), `${afterShort} → ${afterLong}`);
	const match = value.report.match(/完整报告：(\S+?)\]/);
	if (match !== null) rmSync(join(match[1], '..'), { recursive: true, force: true });
}

console.log(`\n${passes} 项通过，${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);