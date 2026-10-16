/**
 * 运行：node selftest.mjs
 *
 * 分区（按此顺序跑）：
 *   A 配置归一化        B 工具描述与参数校验   C CLI 评审者
 *   D LLM 评审者        E 子智能体评审者      F 编排
 *   G 边界              H 回归                I 模型发现与按需指名
 *   J 浏览器半边        J2 自动保存           K GUI 配置的宿主半边
 *
 * 假 ctx 自测：不起宿主进程，也不跑真的 codex / 模型。覆盖
 *
 * - 配置归一化（agents / models / reviewers 展开、非法项降级、模式解析、评审者选择）；
 * - 三种评审者：CLI（argv 拼装 + 结论落盘）、LLM（ctx.llm 流式）、子智能体（ctx.subagents）；
 * - 变更收集：git 摘要、diff 包按需收集、未跟踪文件正文；
 * - 编排：就地返回 / 后台返回 / 纯后台 / 失败收敛 / 汇总 / 截断 / 系统提示词注入。
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLUGIN = new URL('./index.js', import.meta.url).href;

/** 统计 $TMPDIR 里属于本插件的临时目录：整轮自测跑完必须一个不多（不含自测自己的 scratch 目录）。 */
function countWorkDirs() {
	return readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-review-') && !name.startsWith('dsh-review-selftest-')).length;
}
const WORKDIRS_BEFORE = countWorkDirs();

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

/**
 * 加载插件。
 *
 * 「一个都不选 = 不启用」生效之后，绝大多数用例（验证 argv、编排、spec……）不该被迫每次都写
 * `defaultReviewers`，所以这里替它们把配置里定义的评审者都选上——用真实归一化代码推导 id。
 * 想验证选择规则的用例显式传 `defaultReviewers`（包括 `[]`）即可跳过这层。
 */
async function loadPlugin({ plugin, harness = {}, services } = {}) {
	const config = plugin === undefined ? {} : { ...plugin };
	if (!('defaultReviewers' in config) && (config.agents !== undefined || config.models !== undefined || config.reviewers !== undefined)) {
		const { resolveSettings } = await import(new URL('./lib/settings.js', import.meta.url).href);
		const ids = resolveSettings(config).reviewers.filter((reviewer) => reviewer.enabled).map((reviewer) => reviewer.id);
		if (ids.length > 0) config.defaultReviewers = ids;
	}
	const built = makeHarness({ ...harness, services: services ?? harness.services });
	const mod = await import(PLUGIN);
	mod.apply(built.ctx, config);
	return { ...built, definition: built.state.tool, mod, config };
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
			{ provider: 'bailian', model: 'qwen3.8-max', label: 'Qwen' },
			{ provider: 'bailian', model: 'glm-5.3' },
		],
		reviewers: [{ id: 'deep', subagentProvider: 'spawn', agentProvider: 'bailian', agentModel: 'deepseek-v4.1-flash' }],
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
	// adHoc 默认打开：未知 id 可能是调用时才解析出来的 provider/model，不能在这里丢掉。
	check('A 开启 adHoc 时保留未知 defaultReviewers', settings.defaultReviewers.join(',') === 'codex,nope', settings.defaultReviewers.join(','));
	{
		const strict = resolveSettings({ agents: [{ preset: 'codex' }], defaultReviewers: ['codex', 'nope'], discover: { adHoc: false } });
		check('A 关闭 adHoc 时过滤未知 defaultReviewers', strict.defaultReviewers.join(',') === 'codex', strict.defaultReviewers.join(','));
		check('A 关闭 adHoc 时给出告警', strict.warnings.some((w) => w.includes('nope')), strict.warnings.join('|'));
	}
	check('A 未知 strength 降级为 standard', settings.modes.broken?.strength === 'standard');
	check('A 未知 strength 有告警', settings.warnings.some((w) => w.includes('nonsense')));
	check('A defaultMode 生效', settings.defaultMode === 'strict');
	check('A resolveMode 默认模式', resolveMode(settings).name === 'strict');
	const selected = selectReviewers(settings, settings.modes.quick, undefined);
	check('A 模式指定评审者优先', selected.map((r) => r.id).join(',') === 'qwen3.8-max', selected.map((r) => r.id).join(','));
	check('A 调用方指定评审者最高优先', selectReviewers(settings, settings.modes.quick, ['codex']).map((r) => r.id).join(',') === 'codex');
	await rejects('A 未知模式报错', () => resolveMode(settings, 'nope'));
	await rejects('A 未知评审者报错', () => selectReviewers(settings, undefined, ['ghost']));

	// 超时默认不设：评审跑多久由调用方决定，插件不替它掐表。
	check('A 硬超时默认不限制', resolveSettings({}).hardTimeoutMs === 0);
	check('A 前台等待仍有默认值', resolveSettings({}).waitMs === 120000);
	// 一个都不选 = 不启用：unset 与 [] 都不是「全部启用」。
	check('A 未勾选时默认集合为空', resolveSettings({ agents: [{ preset: 'codex' }] }).defaultReviewers.length === 0);
	{
		const empty = resolveSettings({ agents: [{ preset: 'codex' }] });
		await rejects('A 未勾选任何评审者时报错', () => selectReviewers(empty, undefined, undefined));
	}

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
			models: [{ provider: 'bailian', model: 'qwen3.8-max' }],
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
		plugin: { models: [{ provider: 'bailian', model: 'qwen3.8-max', label: 'Qwen', llm: { maxTokens: 4096, temperature: 0 } }] },
		harness: { ...GIT, services },
	});
	const value = await run(h, {});
	check('D 结论进报告', value.report.includes('[P1] src/a.js:1'), value.report.slice(0, 300));
	check('D 报告标注 provider/model', value.report.includes('bailian/qwen3.8-max'));
	check('D 调用了 ctx.llm', llmCalls.length === 1 && llmCalls[0].provider === 'bailian' && llmCalls[0].model === 'qwen3.8-max');
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
	const h = await loadPlugin({ plugin: { models: [{ provider: 'bailian', model: 'glm-5.3' }] }, harness: { ...GIT, services } });
	const value = await run(h, {});
	check('D 模型失败被收敛', value.report.includes('**失败**') && value.report.includes('AUTH'), value.report.slice(0, 300));
}
{
	// 没有 llm 服务：报告里说明，而不是抛给上层。
	const h = await loadPlugin({ plugin: { models: [{ provider: 'bailian', model: 'glm-5.3' }] }, harness: { ...GIT } });
	const value = await run(h, {});
	check('D 缺 ctx.llm 时给出说明', value.report.includes('ctx.llm 服务不可用'), value.report.slice(0, 300));
}
{
	// 模式的强度短语与 prompt 都要进 llm 的 system 槽。
	const calls = [];
	const services = { llm: { stream(options) { calls.push(options); return (async function* stream() { yield { type: 'text-delta', index: 0, text: '结论' }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } } };
	const h = await loadPlugin({
		plugin: {
			models: [{ provider: 'bailian', model: 'qwen3.8-max' }],
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
		plugin: { reviewers: [{ id: 'deep', kind: 'subagent', provider: 'spawn', agentProvider: 'bailian', agentModel: 'deepseek-v4.1-flash', maxDepth: 1, persona: '你是评审者' }] },
		harness: { ...GIT, services },
	});
	const value = await run(h, {});
	check('E 子智能体结论进报告', value.report.includes('子智能体结论'), value.report.slice(0, 300));
	check('E 传了 provider 与 model', subagentCalls[0].request.agentOptions.provider === 'bailian' && subagentCalls[0].request.agentOptions.model === 'deepseek-v4.1-flash');
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
		plugin: { agents: [{ preset: 'codex' }], models: [{ provider: 'bailian', model: 'qwen3.8-max' }] },
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
		plugin: { agents: [{ preset: 'codex' }, { preset: 'gemini' }], models: [{ provider: 'bailian', model: 'qwen3.8-max' }] },
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
				{ provider: 'bailian', model: 'qwen3.8-max' },
				{ provider: 'bailian', model: 'glm-5.3' },
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
	// 截断会刻意保留临时目录；自测自己负责收尾，好让最后的「零泄漏」总账成立。
	const kept = value.report.match(/完整报告：(\S+?)\]/);
	if (kept !== null) rmSync(join(kept[1], '..'), { recursive: true, force: true });
}
{
	// 系统提示词注入：section 始终注册，正文按**当前**配置现算（injectPolicy 与 when 都是
	// GUI 可改的 volatile 字段，注册时算一次就会过期）。
	const makePrompt = () => ({ sections: [], section(section) { this.sections.push(section); return () => {}; }, getSectionOrder: () => 2900 });
	const off = makePrompt();
	const h = await loadPlugin({ plugin: { modes: { strict: { when: 'always' } } }, services: { systemPrompt: off }, harness: {} });
	check('F 始终注册策略段落', off.sections.length === 1 && off.sections[0].name === 'review:policy', JSON.stringify(off.sections.map((s) => s.name)));
	check('F 默认不注入（正文为空）', off.sections[0].text() === '', JSON.stringify(off.sections[0].text()));
	// 模拟 GUI 打开 injectPolicy：不需要重载插件，正文立刻出现
	h.config.injectPolicy = true;
	check('F 打开注入后正文立即出现', off.sections[0].text().includes('任何改动都必须经过') && off.sections[0].text().includes('review'));
	// 再关掉：正文立刻消失（旧的实现在这里会留下过期文本）
	h.config.injectPolicy = false;
	check('F 关掉注入后正文立即消失', off.sections[0].text() === '', JSON.stringify(off.sections[0].text()));
	// 改模式里的 when 同样立即反映
	h.config.injectPolicy = true;
	h.config.modes.strict.when = 'never';
	check('F 改 when 后正文跟着变', off.sections[0].text().includes('本模式不强制评审'), off.sections[0].text());
	const quiet = makePrompt();
	await loadPlugin({ plugin: { injectPolicy: true, modes: { quick: { strength: 'light' } } }, services: { systemPrompt: quiet }, harness: {} });
	check('F 没有 when 时正文为空', quiet.sections[0].text() === '', JSON.stringify(quiet.sections[0].text()));
	check('F section 顺序在工具区之前', quiet.sections[0].order === 2899, String(quiet.sections[0].order));
}

/* ────────────────────────────── G. 非 git 目录 / 空改动 ────────────────────────────── */

console.log('\nG. 边界');
{
	const h = await loadPlugin({
		plugin: { models: [{ provider: 'bailian', model: 'qwen3.8-max' }] },
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
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }], models: [{ provider: 'bailian', model: 'qwen3.8-max' }] }, harness: { ...GIT, gitScript: clean, report: '结论' } });
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
	check('G 不传则用配置里勾选的评审者', value2.reviewers.join(',') === 'codex,claude', value2.reviewers.join(','));
	// 一个都不勾 = 不启用：报错要能指导用户去勾选或显式传参。
	const none = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }, { preset: 'claude' }], defaultReviewers: [] }, harness: { ...GIT, report: '结论' } });
	const error = await rejects('G 一个都不勾时报错', () => run(none, {}));
	check('G 空集合报错可指导操作', error?.message.includes('defaultReviewers') && error?.message.includes('reviewers 参数'), error?.message);
	check('G 空集合不会偷偷跑评审者', !none.state.spawns.some((spec) => spec.argv[0] === '/fake/codex'));
	// 勾了一个就只跑那一个
	const one = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }, { preset: 'claude' }], defaultReviewers: ['claude'] }, harness: { ...GIT, stdout: '结论' } });
	const valueOne = await run(one, {});
	check('G 勾选决定默认集合', valueOne.reviewers.join(',') === 'claude', valueOne.reviewers.join(','));
}

/* ────────────────────────────── H. 回归（真实评审发现的问题） ────────────────────────────── */

console.log('\nH. 回归');
{
	// 未跟踪目录要用 -uall 展开成文件，并且路径按仓库根解析（不是 cwd）。
	const statusArgv = h => h.state.spawns.filter((spec) => spec.argv.includes('status')).map((spec) => spec.argv.join(' '));
	const calls = [];
	const h = await loadPlugin({
		plugin: { models: [{ provider: 'bailian', model: 'qwen3.8-max' }] },
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
				{ id: 'dis', kind: 'llm', provider: 'bailian', model: 'glm-5.3', enabled: false },
				{ id: 'on', kind: 'llm', provider: 'bailian', model: 'qwen3.8-max' },
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
	const count = countWorkDirs;
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
	check('H 清理后回到基线', countWorkDirs() === before, `${afterLong} → ${countWorkDirs()}`);

	// 整轮自测的总账：短路、失败、取消这些路径也都不许漏临时目录。
	// 后台 job 的清理是异步的，先让在途的 done 结算完再数。
	await new Promise((resolve) => setTimeout(resolve, 100));
	const leaked = countWorkDirs();
	const leakedNames = readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-review-'));
	check('H 整轮自测没有泄漏临时目录', leaked === WORKDIRS_BEFORE, `${WORKDIRS_BEFORE} → ${leaked}: ${leakedNames.join(', ')}`);
}

{
	// 回归：指定了 commit/base 时，模式提示词不能让 codex 丢掉范围开关。
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }], modes: { deep: { strength: 'deep', prompt: '彻底看' } }, defaultMode: 'deep' },
		harness: { ...GIT, report: '结论' },
	});
	const value = await run(h, { commit: 'abc123' });
	const argv = h.state.spawns.find((spec) => spec.argv[0] === '/fake/codex').argv;
	check('H 有范围时保留 --commit', argv.includes('--commit') && argv.includes('abc123'), JSON.stringify(argv));
	check('H 有范围时不传 PROMPT', !argv.includes('--'), JSON.stringify(argv));
	check('H 在报告里说明模式的提示词被跳过', value.report.includes('模式的提示词没有传递'), value.report.slice(-500));
	check('H 报告头仍标注提交范围', value.report.includes('提交 abc123 的改动'));
}
{
	// 回归：没有范围时，模式提示词照旧走 codex 的 PROMPT。
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }], modes: { deep: { strength: 'deep' } }, defaultMode: 'deep' },
		harness: { ...GIT, report: '结论' },
	});
	await run(h, {});
	const argv = h.state.spawns.find((spec) => spec.argv[0] === '/fake/codex').argv;
	check('H 无范围时用 PROMPT 取代范围开关', argv.includes('--') && !argv.some((token) => ['--base', '--commit'].includes(token)), JSON.stringify(argv));
	check('H 无范围时 PROMPT 里带模式强度', argv.at(-1).includes('深度评审'), argv.at(-1));
}
{
	// 回归：commit 范围不把当前未跟踪文件算进材料，也不算进变更规模。
	const calls = [];
	const h = await loadPlugin({
		plugin: { models: [{ provider: 'bailian', model: 'qwen3.8-max' }] },
		harness: { ...GIT, services: { llm: { stream(options) { calls.push(options); return (async function* stream() { yield { type: 'text-delta', index: 0, text: '结论' }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } } } },
	});
	const value = await run(h, { commit: 'abc123' });
	const prompt = calls[0].messages[0].content[0].text;
	check('H commit 范围不含未跟踪正文', !prompt.includes('export const b = 2;'), prompt.slice(-400));
	check('H commit 范围不虚增变更规模', value.report.includes('1 个文件'), value.report.slice(0, 300));
	check('H 未跟踪文件被说明为范围外', value.report.includes('不属于本次范围'), value.report.slice(-400));
}
{
	// 回归：argv 投递的提示词要按 UTF-8 字节压到单参数上限内。
	const { clampForArgv } = await import(new URL('./lib/reviewers.js', import.meta.url).href);
	const short = clampForArgv('abc', 100);
	check('H 未超限时原样返回', short.text === 'abc' && short.clamped === false);
	const longText = `${'开头'.repeat(200)}${'中'.repeat(2000)}${'尾'.repeat(200)}`;
	const clamped = clampForArgv(longText, 1024);
	check('H 超限时被截断', clamped.clamped === true && Buffer.byteLength(clamped.text, 'utf8') <= 1024, `${Buffer.byteLength(clamped.text, 'utf8')}`);
	check('H 截断给出标记', clamped.text.includes('单参数上限'));
	check('H 截断不切碎多字节字符', !clamped.text.includes('\uFFFD'));

	// 端到端：一个巨大的 diff 也不会让 argv 超限。
	const huge = `diff --git a/big.js b/big.js\n@@ -1 +1 @@\n+${'中文'.repeat(80_000)}\n`;
	const script = defaultGitScript(WORK).map((entry) => (entry.argv.join(' ').endsWith('diff --no-color') ? { ...entry, stdout: huge } : entry));
	const big = await loadPlugin({ plugin: { agents: [{ preset: 'claude' }] }, harness: { ...GIT, gitScript: script, stdout: '结论' } });
	await run(big, {});
	const spec = big.state.spawns.find((entry) => entry.argv[0] === '/fake/claude');
	const promptArg = spec.argv.at(-1);
	check('H 大 diff 下 prompt 参数受限于 maxArgBytes', Buffer.byteLength(promptArg, 'utf8') <= 96 * 1024, `${Buffer.byteLength(promptArg, 'utf8')}`);
	const bigValue = await run(big, {});
	check('H argv 截断在报告里可见', bigValue.report.includes('单参数') && bigValue.report.includes('claude'), bigValue.report.slice(-400));
}

{
	// 回归：自定义的 codex 形状模板（{range} + {promptArg}）要与内置预设同样处理，
	// 不能同时收到范围开关和 PROMPT。
	const custom = [{ id: 'wrapper', kind: 'cli', preset: 'custom', executable: 'codex-wrapper', command: ['{exe}', 'review', '{range}', '{reportArg}', '{extra}', '{promptArg}'], capture: 'report' }];
	const focus = await loadPlugin({ plugin: { reviewers: custom }, harness: { ...GIT, report: '结论' } });
	await run(focus, { instructions: '只看并发' });
	const focusArgv = focus.state.spawns.find((spec) => spec.argv[0] === '/fake/codex-wrapper').argv;
	check('H 自定义 codex 形状：有 PROMPT 时不带范围开关', !focusArgv.some((token) => ['--uncommitted', '--base', '--commit'].includes(token)), JSON.stringify(focusArgv));
	check('H 自定义 codex 形状：PROMPT 用 -- 终止符', focusArgv.at(-2) === '--' && focusArgv.at(-1) === '只看并发', JSON.stringify(focusArgv.slice(-3)));

	const scoped = await loadPlugin({
		plugin: { reviewers: custom, modes: { deep: { strength: 'deep' } }, defaultMode: 'deep' },
		harness: { ...GIT, report: '结论' },
	});
	await run(scoped, { commit: 'abc123' });
	const scopedArgv = scoped.state.spawns.find((spec) => spec.argv[0] === '/fake/codex-wrapper').argv;
	check('H 自定义 codex 形状：有范围时保留范围且不传 PROMPT', scopedArgv.includes('--commit') && scopedArgv.includes('abc123') && !scopedArgv.includes('--'), JSON.stringify(scopedArgv));
}
{
	// 回归：非 codex 形状的自定义模板（{prompt}）仍然「范围 + 提示词」都给。
	const h = await loadPlugin({
		plugin: { reviewers: [{ id: 'p', kind: 'cli', preset: 'custom', executable: 'plain', command: ['{exe}', '{range}', '{prompt}'], capture: 'stdout' }] },
		harness: { ...GIT, stdout: '结论' },
	});
	await run(h, { base: 'main' });
	const argv = h.state.spawns.find((spec) => spec.argv[0] === '/fake/plain').argv;
	check('H 普通自定义模板保留范围与提示词', argv.includes('--base') && argv.includes('main') && argv.at(-1).includes('评审任务'), JSON.stringify(argv.slice(0, 4)));
}

/* ────────────────────────────── I. 模型发现与按需指名 ────────────────────────────── */

console.log('\nI. 模型发现与按需指名');

/** 一个「DSH 里已经配好模型」的假 llm 服务：provider/model 列表 + 会记账的 stream。 */
function fakeLlm(catalog = { bailian: ['qwen3.8-max', 'glm-5.3', 'text-embedding-v3'], 'deepseek-official': ['deepseek-v4-flash'] }) {
	const calls = [];
	return {
		calls,
		listProviders: () => Object.keys(catalog).map((id) => ({ id, name: id === 'bailian' ? '百炼' : id })),
		async listModels(provider) {
			if (catalog[provider] === undefined) throw new Error('NO_ADAPTER');
			return catalog[provider].map((id) => ({ provider, id, name: id }));
		},
		stream(options) {
			calls.push(options);
			return (async function* stream() {
				yield { type: 'text-delta', index: 0, text: `[结论] ${options.provider}/${options.model}` };
				yield { type: 'finish', reason: { kind: 'stop' } };
			})();
		},
	};
}

/** 只跑一次评审、拿回假 llm 的调用记录。 */
async function reviewWith(plugin, args, catalog) {
	const llm = fakeLlm(catalog);
	const h = await loadPlugin({ plugin, harness: { ...GIT, services: { llm } } });
	const value = await run(h, args);
	return { value, llm, h };
}

{
	// 默认：不打开 discover，但可以直接按 provider/model 指名 DSH 里已注册的模型。
	const { value, llm } = await reviewWith({ agents: [{ preset: 'codex' }] }, { reviewers: ['bailian/glm-5.3'] });
	check('I 默认允许按需指名', llm.calls.length === 1 && llm.calls[0].provider === 'bailian' && llm.calls[0].model === 'glm-5.3', JSON.stringify(llm.calls.map((c) => `${c.provider}/${c.model}`)));
	check('I 报告标注「按需指名」', value.report.includes('按需指名') && value.report.includes('bailian/glm-5.3'), value.report.slice(0, 400));
	check('I 按需指名进了 reviewers 字段', value.reviewers.join(',') === 'bailian/glm-5.3', JSON.stringify(value.reviewers));
	check('I 报告脚注说明来源', value.report.includes('不在插件配置里'), value.report.slice(-500));
}
{
	// 不存在的模型不会被凭空造出来：报错并列出 DSH 现在有什么。
	const llm = fakeLlm();
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, services: { llm } } });
	const error = await rejects('I 拒绝未注册的模型', () => run(h, { reviewers: ['bailian/no-such-model'] }));
	check('I 报错列出已注册模型', error?.message.includes('bailian/qwen3.8-max'), error?.message);
}
{
	// discover 展开：providers 是范围键，写了就自动打开。
	const { value, llm } = await reviewWith({ agents: [{ preset: 'codex' }], discover: { providers: ['bailian'], exclude: ['*embed*'] } }, { reviewers: ['bailian/qwen3.8-max', 'bailian/glm-5.3'] });
	check('I discover 展开后两个模型都跑', llm.calls.length === 2, JSON.stringify(llm.calls.map((c) => c.model)));
	check('I exclude 生效（embedding 不在候选里）', value.report.includes('已把 2 个模型纳入评审者'), value.report.slice(-600));
	check('I 展开的评审者报告里标「自动发现」', value.report.includes('自动发现'), value.report.slice(0, 600));
}
{
	// 裸模型名：唯一才认。
	const { llm } = await reviewWith({ agents: [{ preset: 'codex' }], discover: { providers: ['bailian'] } }, { reviewers: ['glm-5.3'] });
	check('I 裸模型名唯一时可用', llm.calls.length === 1 && llm.calls[0].model === 'glm-5.3', JSON.stringify(llm.calls.map((c) => c.model)));
}
{
	// discover.inDefault：进入默认集合。
	const { llm } = await reviewWith({ discover: { providers: ['bailian'], include: ['glm*'], inDefault: true } }, {});
	check('I inDefault 时自动展开者进默认集合', llm.calls.length === 1 && llm.calls[0].model === 'glm-5.3', JSON.stringify(llm.calls.map((c) => c.model)));
	// 只有 discover、没开 inDefault、也没勾任何评审者：默认集合是空的 → 直接报错（不是把能用的都跑一遍）。
	await rejects('I 未开 inDefault 且没勾选时报错', () => reviewWith({ discover: { providers: ['bailian'], include: ['glm*'] } }, {}));
	// 显式传 reviewers 仍然照跑。
	const explicit = await reviewWith({ discover: { providers: ['bailian'], include: ['glm*'] } }, { reviewers: ['bailian/glm-5.3'] });
	check('I 未勾选但显式指名可用', explicit.llm.calls.length === 1 && explicit.llm.calls[0].model === 'glm-5.3', JSON.stringify(explicit.llm.calls.map((c) => c.model)));
}
{
	// adHoc 关掉后，未配置的模型不可用；defaultReviewers 也在加载时被过滤。
	const llm = fakeLlm();
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }], discover: { adHoc: false } }, harness: { ...GIT, services: { llm } } });
	const error = await rejects('I 关闭 adHoc 后拒绝按需指名', () => run(h, { reviewers: ['bailian/glm-5.3'] }));
	check('I 关闭 adHoc 的报错说明原因', error?.message.includes('adHoc'), error?.message);
}
{
	// 没有静态评审者也能用：discover 单独撑起整个工具。
	const { llm, value } = await reviewWith({ discover: { providers: ['bailian'], include: ['qwen*'], inDefault: true } }, {});
	check('I 只配 discover + inDefault 也能评审', llm.calls.length === 1 && llm.calls[0].model === 'qwen3.8-max', JSON.stringify(llm.calls.map((c) => c.model)));
	check('I 报告头列出发现的评审者', value.reviewers.join(',') === 'bailian/qwen3.8-max', JSON.stringify(value.reviewers));
}
{
	// discover 指定的 provider 没注册：跳过并说明，不报错。
	const { value } = await reviewWith({ agents: [{ preset: 'codex' }], discover: { providers: ['bailian', 'ghost'] } }, { reviewers: ['bailian/glm-5.3'] });
	check('I 未注册的 provider 被跳过并说明', value.report.includes('"ghost" 当前没有注册'), value.report.slice(-600));
}
{
	// listModels 抛错 / 超时：只跳过那个 provider。
	const llm = {
		listProviders: () => [{ id: 'bailian', name: '百炼' }, { id: 'broken', name: 'broken' }],
		async listModels(provider) {
			if (provider === 'broken') throw new Error('boom');
			return [{ provider, id: 'qwen3.8-max', name: 'qwen3.8-max' }];
		},
		*stream() {
			yield { type: 'text-delta', index: 0, text: '结论' };
			yield { type: 'finish', reason: { kind: 'stop' } };
		},
	};
	// discover: true 展开全部 provider，inDefault 让它们进默认集合（否则「一个都不选」= 不启用）。
	const h = await loadPlugin({ plugin: { discover: { enabled: true, inDefault: true } }, harness: { ...GIT, services: { llm } } });
	const value = await run(h, {});
	check('I 一个 provider 报错不影响其他', value.report.includes('结论') && value.report.includes('模型列表获取失败，已跳过'), value.report.slice(-600));
}
{
	// 工具描述要把「可以直接写 provider/model」讲清楚。
	const llm = fakeLlm();
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, services: { llm } } });
	const description = h.definition.description;
	check('I 描述说明可按需指名', description.includes('provider/model') && description.includes('已注册的任意模型'), description.slice(0, 600));
	check('I 描述列出已注册 provider', description.includes('bailian') && description.includes('deepseek-official'), description.slice(0, 700));
	const withDiscover = await loadPlugin({ plugin: { discover: { providers: ['bailian'], exclude: ['*embed*'] } }, harness: { ...GIT, services: { llm } } });
	check('I 描述说明 discover 已打开', withDiscover.definition.description.includes('discover') && withDiscover.definition.description.includes('已排除'), withDiscover.definition.description.slice(0, 700));
}

/* ────────────────────────────── J. 浏览器半边（client bundle） ────────────────────────────── */

console.log('\nJ. 浏览器半边');

/**
 * 用桩件在 Node 里加载 client/client.js：真实格式是 window.__ModuleLoader__.load({id, factory})，
 * 工厂只要 react 与 primitives 两个 external，所以替身足够跑通 apply、纯逻辑与渲染树。
 */
async function loadClientBundle(options = {}) {
	const captured = { registrations: [], slots: [], locales: [], effects: [], disposers: [], models: [], scope: undefined, entry: undefined, served: undefined };
	const asArray = (value) => (value === undefined || value === null || value === false ? [] : Array.isArray(value) ? value.flat() : [value]);
	// React 会把 children 同时放进 props.children；桩件也照做，组件内部才能读到 props.children。
	const react = {
		createElement: (type, props, ...children) => {
			const kids = children.flat().filter((child) => child !== null && child !== undefined && child !== false);
			const merged = { ...(props ?? {}) };
			if (kids.length > 0) merged.children = kids.length === 1 ? kids[0] : kids;
			return { type, props: merged, children: kids };
		},
		// forceInitial 让用例可以「点开」默认收起的分区（桩件没有真正的 state 更新）。
		useState: (initial) => [options.forceInitial === undefined ? (typeof initial === 'function' ? initial() : initial) : options.forceInitial, () => {}],
		useId: () => 'id',
	};
	class SettingsFormModel {
		constructor(scope, specs) {
			this.scope = scope;
			this.specs = specs;
			// 与官方模型一致的可观察状态：编辑变 dirty、保存成功清 dirty、失败保留草稿。
			this.dirty = false;
			this.invalid = false;
			this.failed = false;
			this.saving = false;
			this.writable = options.writable ?? true;
			this.failuresLeft = options.saveFailures ?? 0;
			this.saveCalls = 0;
			this.discardCalls = 0;
			this.editLog = [];
			this.resetLog = [];
			captured.models.push(this);
		}
		bind(project) {
			this.project = project;
			return { getSnapshot: () => project(), subscribe: () => () => {} };
		}
		shell() {
			return { available: true, writable: this.writable, dirty: this.dirty, invalid: this.invalid, saving: this.saving, failed: this.failed };
		}
		field(name) {
			const spec = this.specs.find((entry) => entry.field === name);
			if (spec === undefined) return undefined;
			const value = this.scope.getSnapshot().value ?? {};
			const read = (path) => path.split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), value);
			return { text: spec.format(read(name)), overridden: false, invalid: false };
		}
		actions() {
			return {
				edit: (field) => {
					this.dirty = true;
					this.editLog.push(field);
				},
				resetField: (field) => {
					this.dirty = true;
					this.resetLog.push(field);
				},
				save: () => this.save(),
				discard: () => {
					this.discardCalls += 1;
					this.dirty = false;
					this.failed = false;
				},
			};
		}
		async save() {
			this.saveCalls += 1;
			if (options.saveThrows === true) throw new Error('transport down');
			if (this.saving) return; // 与官方一致：保存中再调会被直接挡掉
			this.saving = true;
			const delay = options.saveDelayMs ?? 0;
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
			this.saving = false;
			if (this.failuresLeft > 0) {
				this.failuresLeft -= 1;
				this.failed = true; // 失败时保留草稿（dirty 仍为 true）
				return;
			}
			this.dirty = false;
			this.failed = false;
		}
		dispose() {}
	}
	const primitives = { SettingsFormModel };
	// 这五个会渲染 children（表单容器、按钮、菜单锚点），其余是叶子控件。
	primitives.SettingsForm = (props) => ({ type: 'SettingsForm', props, children: asArray(props.children) });
	primitives.Button = (props) => ({ type: 'Button', props, children: asArray(props.children) });
	primitives.Menu = (props) => ({ type: 'Menu', props, children: asArray(props.anchor) });
	for (const name of ['SettingsValueField', 'Switch', 'Checkbox', 'SegmentedControl', 'Input']) primitives[name] = (props) => ({ type: name, props, children: [] });
	primitives.settingsTextField = (field) => ({ field, format: (value) => (value === undefined || value === null ? '' : String(value)), parse: (text) => (String(text).trim() === '' ? { kind: 'clear' } : { kind: 'set', value: String(text) }) });
	primitives.settingsNumberField = (field) => ({
		field,
		format: (value) => (value === undefined || value === null ? '' : String(value)),
		parse: (text) => {
			const raw = String(text).trim();
			if (raw === '') return { kind: 'clear' };
			const value = Number(raw);
			return Number.isFinite(value) && Number.isInteger(value) ? { kind: 'set', value } : undefined;
		},
	});

	const scope = {
		getSnapshot: () => ({
			status: 'ready',
			value: options.value ?? {
				defaultReviewers: ['codex', 'qwen'],
				injectPolicy: true,
				language: 'zh',
				reviewers: [
					{ id: 'codex', kind: 'cli', preset: 'codex', executable: 'codex' },
					{ id: 'qwen', kind: 'llm', provider: 'bailian', model: 'qwen3.8-max' },
				],
				modes: { deep: { strength: 'deep', reviewers: ['codex', 'qwen'], synthesize: true, when: 'complex' } },
				discover: { enabled: true, providers: ['bailian'], exclude: ['*embedding*'] },
			},
			base: {},
			user: {},
			writable: true,
			revision: 7,
		}),
		subscribe: () => () => {},
		mutate: async () => true,
	};
	const catalogResult = options.catalog ?? {
		ok: true,
		value: {
			groups: [
				{ id: 'bailian', name: '百炼', models: [{ id: 'qwen3.8-max', name: 'qwen3.8-max' }, { id: 'glm-5.3', name: 'glm-5.3' }] },
				{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'flash' }] },
			],
			failures: [],
		},
	};
	const ctx = {
		locale: { bind: () => (key) => key, register: (ns, dictionaries) => (captured.locales.push({ ns, dictionaries }), () => {}) },
		configForms: {
			get: (entry) => ((captured.entry = entry), scope),
			whileServed: (namespaces, register) => ((captured.served = namespaces), register(), () => {}),
		},
		slots: {
			inject: (name, register) => (captured.slots.push(name), register()),
			register: (slotOptions, render) => {
				captured.registrations.push({ options: slotOptions, render });
				return () => {};
			},
		},
		effect: (fn, label) => {
			captured.effects.push(label);
			const dispose = fn();
			captured.disposers.push(dispose);
			return dispose;
		},
		get: (service) => (service === 'remote.session' ? { modelCatalog: async () => catalogResult } : undefined),
	};

	let loaded;
	globalThis.window = { __ModuleLoader__: { load: (args) => (loaded = args) } };
	const source = readFileSync(new URL('./client/client.js', import.meta.url), 'utf8');
	new Function('window', source)(globalThis.window);
	const mod = loaded.factory((name) => {
		if (name === 'react') return react;
		if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
		throw new Error(`未知 external: ${name}`);
	});
	return { mod, ctx, captured, scope, react, primitives };
}

/**
 * 把元素树渲染成节点树：函数组件（本插件的 Field / ReviewerRow / 原语桩件…）都调用一次。
 * 桩件版的 react 不跑真正 renderer，但组件只用 useState，替身能安全执行。
 */
function renderTree(node) {
	if (node === null || node === undefined || node === false) return [];
	if (Array.isArray(node)) return node.flatMap(renderTree);
	if (typeof node !== 'object') return [];
	if (typeof node.type === 'function') return renderTree(node.type(node.props));
	return [node, ...(node.children ?? []).flatMap(renderTree)];
}

/** 在渲染树里找所有满足条件的节点。 */
function findAll(node, predicate) {
	return renderTree(node).filter(predicate);
}

{
	const { mod, ctx, captured, primitives: bundlePrimitives } = await loadClientBundle();
	const I = mod.__internals;
	check('J 导出 name', mod.name === 'dsh-review', mod.name);
	check('J 导出 inject（slots/locale/configForms）', JSON.stringify(mod.inject) === JSON.stringify(['slots', 'locale', 'configForms']), JSON.stringify(mod.inject));
	check('J 导出 apply 与自测内部件', typeof mod.apply === 'function' && typeof I === 'object');

	// ── 样式：宿主不会替第三方页面排版，class 没有配套 CSS 就会退回浏览器默认样式 ──
	{
		// 只扫 className（元素 id 不需要样式规则）。
		const classes = [...new Set([...readFileSync(new URL('./client/client.js', import.meta.url), 'utf8').matchAll(/className: '(dsh-review-[a-z0-9-]+)'/g)].map((match) => match[1]))].sort();
		check('J 代码里确实用到了一批自有 class', classes.length >= 25, String(classes.length));
		const unstyled = classes.filter((name) => !I.STYLES.includes(`.${name}`));
		check('J 每个自有 class 都有样式', unstyled.length === 0, unstyled.join(', '));
		// 与官方 settings-form 同一套设计变量与度量，亮暗主题自动跟随
		check('J 样式沿用宿主设计变量', ['--dsw-alias-label-primary', '--dsw-alias-label-tertiary', '--dsw-alias-border-l2', '--dsw-radius-md', '--dsw-focus-ring-width'].every((token) => I.STYLES.includes(token)));
		check('J 样式与官方度量一致', I.STYLES.includes('font-size: 13px') && I.STYLES.includes('font-size: 12px') && I.STYLES.includes('0.5px solid'));
		// 折叠头是原生 button：必须清掉浏览器默认样式，否则一眼就是「没排版」
		check('J 折叠头清掉了默认按钮样式', I.STYLES.includes('.dsh-review-group-head {') && /appearance: none/.test(I.STYLES) && /border: 0/.test(I.STYLES));
		check('J 列表去掉了默认项目符号与缩进', /list-style: none/.test(I.STYLES) && /padding: 0/.test(I.STYLES));
	}

	// ── 样式注入：有 document 时插一次、重复调用不重复插 ──
	{
		const tags = [];
		const head = [];
		globalThis.document = {
			head: { appendChild: (tag) => head.push(tag) },
			querySelector: (selector) => head.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
			createElement: () => {
				const tag = { dataset: {}, textContent: '' };
				tags.push(tag);
				return tag;
			},
		};
		const disposeA = I.injectStyles();
		check('J 注入样式标签', tags.length === 1 && tags[0].textContent === I.STYLES && tags[0].dataset.plugin === 'dsh-review', String(tags.length));
		I.injectStyles();
		check('J 重复注入不重复插标签', tags.length === 1, String(tags.length));
		disposeA();
		check('J 卸载时保留标签（与官方页面一致，靠 dataset 去重）', head.length === 1);
		delete globalThis.document;
		check('J 没有 document 时安全降级', typeof I.injectStyles() === 'function');
	}

	// ── 纯逻辑：文本 ↔ 表格（结构化编辑器与原始 JSON 共用同一份值）──
	check('J splitList 支持逗号/换行/空白', JSON.stringify(I.splitList(' a , \n b ,, c ')) === JSON.stringify(['a', 'b', 'c']));
	check('J parseJson 失败给兜底', JSON.stringify(I.parseJson('{bad', ['x'])) === JSON.stringify(['x']) && JSON.stringify(I.parseJson('', ['x'])) === JSON.stringify(['x']));
	const rows = I.reviewerRows('[{"id":"a","kind":"llm"},{"id":"b"}]');
	check('J reviewerRows 读出两行', rows.length === 2 && rows[0].id === 'a', JSON.stringify(rows));
	check('J reviewerRows 丢掉非对象元素', I.reviewerRows('[1,"x",{"id":"a"}]').length === 1);
	check('J reviewerRows 对坏 JSON 返回空', I.reviewerRows('{bad').length === 0);
	check('J serializeReviewers 往返一致', JSON.stringify(I.reviewerRows(I.serializeReviewers(rows)).map((row) => row.id)) === JSON.stringify(['a', 'b']));
	check('J serializeReviewers 空数组写成空串', I.serializeReviewers([]) === '');
	const modes = I.modeRows('{"deep":{"strength":"deep"},"quick":{"strength":"light"}}');
	check('J modeRows 读出模式名', modes.map((row) => row.name).join(',') === 'deep,quick', JSON.stringify(modes.map((row) => row.name)));
	check('J serializeModes 往返一致', Object.keys(JSON.parse(I.serializeModes(modes))).join(',') === 'deep,quick');
	check('J modeRows 对数组/坏 JSON 返回空', I.modeRows('[1]').length === 0 && I.modeRows('{bad').length === 0);
	// 开关的「生效值」必须与宿主侧推断一致，否则会显示成关闭而实际开着。
	check('J 生效值：显式 true/false 优先', I.effectiveDiscoverEnabled('true', '', '') === true && I.effectiveDiscoverEnabled('false', 'bailian', 'qwen*') === false);
	check('J 生效值：写了 providers 就算打开', I.effectiveDiscoverEnabled('', 'bailian', '') === true);
	check('J 生效值：写了 include 也算打开', I.effectiveDiscoverEnabled('', '', 'qwen*') === true);
	check('J 生效值：什么都没写就不打开', I.effectiveDiscoverEnabled('', '', '') === false && I.effectiveDiscoverEnabled(undefined, undefined, undefined) === false);
	check('J cleanupModeBody 删掉空值', JSON.stringify(I.cleanupModeBody({ when: '', synthesize: undefined, reviewers: [], strength: 'deep', minChangedLines: Number.NaN })) === JSON.stringify({ strength: 'deep' }));

	// ── glob 语义：include/exclude 全靠它，匹配错了会静默筛掉/留下错误的模型 ──
	{
		const { matchesPattern } = await import(new URL('./lib/discovery.js', import.meta.url).href);
		check('J glob 裸模式按模型名匹配', matchesPattern('*embed*', 'bailian', 'text-embedding-v3') === true);
		check('J glob 裸模式不匹配无关模型', matchesPattern('*embed*', 'bailian', 'qwen3.8-max') === false);
		check('J glob 带 / 时按 provider/model 匹配', matchesPattern('bailian/qwen*', 'bailian', 'qwen3.8-max') === true);
		check('J glob 带 / 时看 provider', matchesPattern('bailian/qwen*', 'deepseek-official', 'qwen3.8-max') === false);
		check('J glob 大小写不敏感', matchesPattern('QWEN*', 'bailian', 'qwen3.8-max') === true);
		check('J glob ? 匹配单个字符', matchesPattern('qwen?.8-max', 'bailian', 'qwen3.8-max') === true && matchesPattern('qwen?.8-max', 'bailian', 'qwen38-max') === false);
		check('J glob 不做部分匹配（整串锚定）', matchesPattern('qwen', 'bailian', 'qwen3.8-max') === false);
		check('J glob 特殊字符按字面处理', matchesPattern('a.b*', 'p', 'a.bc') === true && matchesPattern('a.b*', 'p', 'axbc') === false);
	}

	// ── 目录映射与选项推导 ──
	const groups = I.catalogGroups({ groups: [{ id: 'bailian', name: '百炼', models: [{ id: 'qwen3.8-max' }] }, { nonsense: true }, { id: 'x', models: [null, { id: 'ok' }] }] });
	check('J catalogGroups 过滤坏形状', groups.length === 2 && groups[0].name === '百炼' && groups[1].models.length === 1, JSON.stringify(groups.map((g) => g.id)));
	check('J catalogGroups 对空目录返回空', I.catalogGroups(undefined).length === 0 && I.catalogGroups({ groups: 'nope' }).length === 0);
	const options = I.selectOptions([{ value: 'a', label: 'A' }], 'zzz');
	check('J selectOptions 保留不在列表里的当前值', options.length === 2 && options[1].value === 'zzz', JSON.stringify(options));
	check('J presetExecutable 把 cursor 映射到 cursor-agent', I.presetExecutable('cursor') === 'cursor-agent' && I.presetExecutable('codex') === 'codex');
	const withCatalog = I.newReviewerRow(3, groups);
	check('J 新行优先给模型评审者', withCatalog.kind === 'llm' && withCatalog.provider === 'bailian' && withCatalog.model === 'qwen3.8-max' && withCatalog.id === 'reviewer-3', JSON.stringify(withCatalog));
	const withoutCatalog = I.newReviewerRow(1, []);
	check('J 没有目录时新行给 codex CLI', withoutCatalog.kind === 'cli' && withoutCatalog.preset === 'codex' && withoutCatalog.executable === 'codex', JSON.stringify(withoutCatalog));

	// ── 字段清单：每个字段都有控件与分组 ──
	const paths = I.FIELDS.map((field) => field.path);
	check('J 字段数量', I.FIELDS.length === 20, String(I.FIELDS.length));
	check('J 字段路径唯一', new Set(paths).size === paths.length);
	// 结构：defaultReviewers 归顶部列表，reviewers 常显，其余都在 advanced 的子分组里
	const bySection = (section) => I.FIELDS.filter((field) => field.section === section).map((field) => field.path).sort().join(',');
	check('J 顶部列表只管 defaultReviewers', bySection('active') === 'defaultReviewers', bySection('active'));
	check('J 评审者定义常显', bySection('reviewers') === 'reviewers', bySection('reviewers'));
	check('J 其余字段都在高级配置里', I.FIELDS.filter((field) => field.section === 'advanced').length === 18, String(I.FIELDS.filter((field) => field.section === 'advanced').length));
	check('J 高级子分组都非空', I.ADVANCED_GROUPS.every((group) => I.FIELDS.some((field) => field.section === 'advanced' && field.group === group.key)), JSON.stringify(I.ADVANCED_GROUPS));
	const switchFields = I.FIELDS.filter((field) => field.control === 'switch').length;
	const textFields = I.FIELDS.filter((field) => field.control === 'text' || field.control === 'number').length;
	check('J 布尔字段用 Switch', switchFields === 4, String(switchFields));
	check('J 结构化编辑器接管 reviewers/modes', I.FIELDS.filter((field) => field.control === 'reviewers' || field.control === 'modes').map((field) => field.path).join(',') === 'reviewers,modes');
	check('J 数字字段都给了 numeric', I.FIELDS.filter((field) => field.control === 'number').every((field) => field.numeric === true));

	// ── spec：校验会真的拦住保存 ──
	mod.apply(ctx);
	const model = captured.models[0];
	const spec = (name) => model.specs.find((entry) => entry.field === name);
	check('J 注册中英字典', captured.locales.length === 1 && captured.locales[0].ns === 'dsh-review' && Boolean(captured.locales[0].dictionaries.zh) && Boolean(captured.locales[0].dictionaries.en));
	// ── 字典：中英必须一一对应，否则英文界面会显示成键名 ──
	{
		const dictionaries = captured.locales[0].dictionaries;
		const zhKeys = Object.keys(dictionaries.zh).sort();
		const enKeys = Object.keys(dictionaries.en).sort();
		check('J 中英字典键完全一致', JSON.stringify(zhKeys) === JSON.stringify(enKeys), `只在 zh: ${zhKeys.filter((k) => !enKeys.includes(k)).join(',')} / 只在 en: ${enKeys.filter((k) => !zhKeys.includes(k)).join(',')}`);
		check('J 字典键数量合理', zhKeys.length >= 100, String(zhKeys.length));
		// 每个键都要被用到（t('key')、三元里的键、以及 FIELDS 里的 label/hint）
		const source = readFileSync(new URL('./client/client.js', import.meta.url), 'utf8');
		const used = new Set([...source.matchAll(/t\('([A-Za-z0-9]+)'\)/g)].map((match) => match[1]));
		for (const match of source.matchAll(/\?\s*'([A-Za-z0-9]+)'\s*:\s*'([A-Za-z0-9]+)'/g)) {
			used.add(match[1]);
			used.add(match[2]);
		}
		for (const match of source.matchAll(/(?:label|hint|invalid):\s*'([A-Za-z0-9]+)'/g)) used.add(match[1]);
		const unused = zhKeys.filter((key) => !used.has(key));
		check('J 没有没人用的文案键', unused.length === 0, unused.join(','));
	}

	check('J 读取 review 命名空间', captured.entry === 'review', captured.entry);
	check('J 只在宿主 serve 命名空间时挂载', JSON.stringify(captured.served) === JSON.stringify(['review']), JSON.stringify(captured.served));
	check('J 行页与包页两个槽位都占', JSON.stringify(captured.slots) === JSON.stringify(['plugins.row.config', 'plugins.bundle.config']), JSON.stringify(captured.slots));
	check('J 槽位 key 正确', JSON.stringify(captured.registrations.map((entry) => entry.options.key)) === JSON.stringify(['dsh-review#review', 'dsh-review']), JSON.stringify(captured.registrations.map((entry) => entry.options.key)));
	const face = captured.registrations[0].options.inject();
	check('J inject 提供表单 hook、目录 hook 与写动作', Boolean(face.hooks?.reviewConfigForm) && Boolean(face.hooks?.reviewCatalog) && typeof face.save === 'function' && typeof face.edit === 'function' && typeof face.resetField === 'function', Object.keys(face).join(','));
	check('J 布尔 spec 认是/否', JSON.stringify(spec('injectPolicy').parse('是')) === JSON.stringify({ kind: 'set', value: true }) && JSON.stringify(spec('injectPolicy').parse('off')) === JSON.stringify({ kind: 'set', value: false }));
	check('J 布尔 spec 拒绝乱填', spec('injectPolicy').parse('maybe') === undefined);
	check('J 列表 spec 空值 = 清除', JSON.stringify(spec('discover.exclude').parse('  ')) === JSON.stringify({ kind: 'clear' }));
	check('J 数字 spec 拒绝负数与小数', spec('maxArgBytes').parse('-1') === undefined && spec('waitMs').parse('1.5') === undefined && spec('waitMs').parse('60000')?.value === 60000);
	check('J reviewers spec 接受合法数组', Array.isArray(spec('reviewers').parse('[{"id":"a","kind":"llm"}]')?.value));
	check('J reviewers spec 拒绝缺 id', spec('reviewers').parse('[{"kind":"llm"}]') === undefined);
	check('J reviewers spec 拒绝非法 kind', spec('reviewers').parse('[{"id":"a","kind":"nope"}]') === undefined);
	check('J reviewers spec 拒绝对象', spec('reviewers').parse('{"id":"a"}') === undefined);
	check('J modes spec 接受合法对象', Object.keys(spec('modes').parse('{"deep":{"strength":"deep"}}')?.value ?? {}).join(',') === 'deep');
	check('J modes spec 拒绝非法 strength', spec('modes').parse('{"deep":{"strength":"nope"}}') === undefined);
	check('J modes spec 拒绝数组', spec('modes').parse('[1]') === undefined);

	// ── 目录：async 加载进 store，页面能读到 ──
	await new Promise((resolve) => setTimeout(resolve, 0));
	const catalogSnapshot = face.hooks.reviewCatalog.getSnapshot();
	check('J 目录加载成功并带 provider', catalogSnapshot.status === 'ready' && catalogSnapshot.groups.length === 2, JSON.stringify({ status: catalogSnapshot.status, groups: catalogSnapshot.groups.length }));

	// ── 渲染树（默认：高级配置收起）──
	const page = captured.registrations[0].render;
	const view = {
		shell: model.shell(),
		fields: Object.fromEntries(model.specs.map((entry) => [entry.field, model.field(entry.field)])),
	};
	const renderProps = { view: 'page', t: (key) => key, ...face, useReviewConfigForm: (selector) => selector(view), useReviewCatalog: (selector) => selector(catalogSnapshot) };
	check('J summary 视图返回一行说明', typeof page({ ...renderProps, view: 'summary' }) === 'string');
	const element = page(renderProps);
	check('J 页面用 SettingsForm 包住控件', element?.type === bundlePrimitives.SettingsForm, String(typeof element?.type));
	check('J 表单带 save/discard', typeof element.props.onSave === 'function' && typeof element.props.onDiscard === 'function');
	const basicSections = findAll(element, (node) => node.type === 'section' && (node.props['data-section'] === 'active' || node.props['data-section'] === 'reviewers'));
	check('J 常显分区顺序：先启用列表，再评审者定义', basicSections.map((node) => node.props['data-section']).join(',') === 'active,reviewers', JSON.stringify(basicSections.map((node) => node.props['data-section'])));
	const advancedHeader = findAll(element, (node) => node.type === 'button' && node.props.id === 'dsh-review-advanced');
	check('J 高级配置有折叠开关', advancedHeader.length === 1 && advancedHeader[0].props['aria-expanded'] === false, JSON.stringify(advancedHeader.map((node) => node.props['aria-expanded'])));
	// 收起时：只有「启用列表」的开关 + 每行评审者的启用开关
	check('J 收起时只有启用列表与行内开关', findAll(element, (node) => node.type === 'Switch').length === 2 + 2, String(findAll(element, (node) => node.type === 'Switch').length));
	check('J 收起时不渲染高级字段', findAll(element, (node) => node.type === 'SegmentedControl').length === 2, String(findAll(element, (node) => node.type === 'SegmentedControl').length));
	check('J 收起时没有预算输入框', findAll(element, (node) => node.type === 'SettingsValueField').length === 0, String(findAll(element, (node) => node.type === 'SettingsValueField').length));
	check('J 收起时没有模式编辑器', findAll(element, (node) => node.type === 'Button').every((node) => node.props.children !== 'addMode'));
	// 顶部列表：2 个定义（codex / qwen），都被 defaultReviewers 勾上，并显示指向什么
	const activeList = findAll(element, (node) => node.props?.className === 'dsh-review-active-item');
	check('J 顶部列出全部启用的评审者', activeList.length === 2, String(activeList.length));
	check('J 顶部列出 id 与指向', findAll(element, (node) => node.props?.className === 'dsh-review-active-id').map((node) => node.props.children).join(',') === 'codex,qwen', JSON.stringify(findAll(element, (node) => node.props?.className === 'dsh-review-active-id').map((node) => node.props.children)));
	check('J 顶部显示指向的模型/可执行', findAll(element, (node) => node.props?.className === 'dsh-review-active-meta').map((node) => node.props.children).join(' | ') === 'cli · codex | llm · bailian/qwen3.8-max', JSON.stringify(findAll(element, (node) => node.props?.className === 'dsh-review-active-meta').map((node) => node.props.children)));
	check('J 顶部开关反映勾选状态', findAll(element, (node) => node.props?.className === 'dsh-review-active-item').every((item) => findAll(item, (node) => node.type === 'Switch')[0]?.props.checked === true));
	check('J 已勾选时不显示告警', findAll(element, (node) => node.props?.className === 'dsh-review-invalid').length === 0);
	// 评审者定义区：行编辑器 + 增删都在
	check('J 每行评审者有删除按钮', findAll(element, (node) => node.type === 'Button').filter((node) => node.props.children === 'remove').length === 2, String(findAll(element, (node) => node.type === 'Button').filter((node) => node.props.children === 'remove').length));
	// 行 key 必须是位置：id / 模式名是可编辑的，把它们放进 key 会让每敲一个字符就换 key、
	// 输入框被重新挂载从而失焦。桩件不保留 React 的 key，所以直接查源码这条不变量。
	const source = readFileSync(new URL('./client/client.js', import.meta.url), 'utf8');
	check('J 行 key 不来自可编辑值', !/key: `\$\{row\.(id|name)/.test(source) && (source.match(/key: index,/g) ?? []).length === 2, String((source.match(/key: index,/g) ?? []).length));
	check('J 有添加评审者按钮', findAll(element, (node) => node.type === 'Button').filter((node) => node.props.children === 'addReviewer').length === 1);
	check('J JSON 兜底默认收起', findAll(element, (node) => node.type === 'SettingsValueField').length === 0);
}

{
	// 展开高级配置（桩件强制 useState 初值为 true）：所有高级字段都该出现。
	const { mod, ctx, captured, primitives: bundlePrimitives, react } = await loadClientBundle({ forceInitial: true });
	const I = mod.__internals;
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	await new Promise((resolve) => setTimeout(resolve, 0));
	const view = { shell: model.shell(), fields: Object.fromEntries(model.specs.map((entry) => [entry.field, model.field(entry.field)])) };
	const element = captured.registrations[0].render({ view: 'page', t: (key) => key, ...face, useReviewConfigForm: (selector) => selector(view), useReviewCatalog: (selector) => selector(face.hooks.reviewCatalog.getSnapshot()) });
	const textFields = I.FIELDS.filter((field) => field.control === 'text' || field.control === 'number').length;
	check('J 展开后高级字段出现', findAll(element, (node) => node.type === 'SettingsValueField').length === textFields, `${findAll(element, (node) => node.type === 'SettingsValueField').length} vs ${textFields}`);
	// JSON 兜底与模式提示词都是多行文本框（单行输入框编辑 JSON 太难用）。
	const textareas = findAll(element, (node) => node.type === 'textarea');
	check('J JSON 兜底用多行文本框', textareas.filter((node) => String(node.props.className).includes('dsh-review-textarea--mono')).length === 2, String(textareas.length));
	check('J 模式提示词用多行文本框', textareas.some((node) => node.props.rows === 2));
	check('J 展开后有四个高级子分组', findAll(element, (node) => node.props?.className === 'dsh-review-subgroup').length === I.ADVANCED_GROUPS.length, String(findAll(element, (node) => node.props?.className === 'dsh-review-subgroup').length));
	const switches = findAll(element, (node) => node.type === 'Switch');
	// 4 个布尔字段 + 顶部列表 2 个 + 评审者行内 2 个 + 模式的合并开关 1 个
	check('J 展开后开关数量（字段 4 + 顶部 2 + 行内 2 + 合并 1）', switches.length === 4 + 2 + 2 + 1, String(switches.length));
	const discoverHolder = findAll(element, (node) => node.props?.className === 'dsh-review-field').find((node) => findAll(node, (child) => child.props?.children === 'discoverEnabled').length > 0);
	check('J 推断生效的开关显示为开', findAll(discoverHolder, (node) => node.type === 'Switch')[0]?.props?.checked === true, JSON.stringify(findAll(discoverHolder, (node) => node.type === 'Switch').map((n) => n.props.checked)));
	check('J 展开后有「添加模式」', findAll(element, (node) => node.type === 'Button').filter((node) => node.props.children === 'addMode').length === 1);
	check('J 展开后下拉与分段控件齐备', findAll(element, (node) => node.type === 'Menu').length >= 4 && findAll(element, (node) => node.type === 'SegmentedControl').length >= 4, `${findAll(element, (node) => node.type === 'Menu').length}/${findAll(element, (node) => node.type === 'SegmentedControl').length}`);
	void bundlePrimitives;
	void react;
}

{
	// 目录不可用：provider 选择退回手填，页面照样渲染。
	const { mod, ctx, captured } = await loadClientBundle({ catalog: { ok: false } });
	mod.apply(ctx);
	const face = captured.registrations[0].options.inject();
	await new Promise((resolve) => setTimeout(resolve, 0));
	check('J 目录失败时状态为 error', face.hooks.reviewCatalog.getSnapshot().status === 'error', face.hooks.reviewCatalog.getSnapshot().status);
	const model = captured.models[0];
	const view = { shell: model.shell(), fields: Object.fromEntries(model.specs.map((entry) => [entry.field, model.field(entry.field)])) };
	const element = captured.registrations[0].render({ view: 'page', t: (key) => key, ...face, useReviewConfigForm: (selector) => selector(view), useReviewCatalog: (selector) => selector(face.hooks.reviewCatalog.getSnapshot()) });
	check('J 目录失败时提示可见', findAll(element, (node) => node.props?.children === 'catalogFailed').length === 1);
	check('J 目录失败时仍渲染表单', element?.type !== undefined && findAll(element, (node) => node.type === 'Input').length > 0);
}

/* ────────────────────────────── J2. 自动保存 ────────────────────────────── */

console.log('\nJ2. 自动保存');

{
	// 编辑后防抖落盘；状态从 pending → saving → saved。
	const { mod, ctx, captured } = await loadClientBundle({ saveFailures: 0 });
	const I = mod.__internals;
	I.AUTO.delayMs = 5; // 测试里不必等 500ms
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	check('J2 初始状态是 idle', face.hooks.reviewAutosave.getSnapshot().status === 'idle', face.hooks.reviewAutosave.getSnapshot().status);
	face.edit('language', 'en');
	check('J2 编辑后进入 pending', face.hooks.reviewAutosave.getSnapshot().status === 'pending', face.hooks.reviewAutosave.getSnapshot().status);
	check('J2 防抖期间还没写', model.saveCalls === 0, String(model.saveCalls));
	await new Promise((resolve) => setTimeout(resolve, 30));
	check('J2 防抖结束后写了一次', model.saveCalls === 1, String(model.saveCalls));
	check('J2 写完状态是 saved', face.hooks.reviewAutosave.getSnapshot().status === 'saved' && model.dirty === false, face.hooks.reviewAutosave.getSnapshot().status);
	I.AUTO.delayMs = 500; // 复原
}

{
	// 连续编辑只写一次（防抖），落盘用的是最后一次编辑。
	const { mod, ctx, captured } = await loadClientBundle({});
	const I = mod.__internals;
	I.AUTO.delayMs = 5;
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	face.edit('language', 'e');
	face.edit('language', 'en');
	face.edit('language', 'en');
	await new Promise((resolve) => setTimeout(resolve, 30));
	check('J2 连续编辑只写一次', model.saveCalls === 1, String(model.saveCalls));
	I.AUTO.delayMs = 500;
}

{
	// 取值不合法时不写盘，状态为 blocked（避免把半截数值写下去）。
	const { mod, ctx, captured } = await loadClientBundle({});
	const I = mod.__internals;
	I.AUTO.delayMs = 5;
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	model.dirty = true;
	model.invalid = true;
	face.edit('waitMs', '1');
	await new Promise((resolve) => setTimeout(resolve, 30));
	check('J2 非法值不写盘', model.saveCalls === 0, String(model.saveCalls));
	check('J2 非法值状态为 blocked', face.hooks.reviewAutosave.getSnapshot().status === 'blocked', face.hooks.reviewAutosave.getSnapshot().status);
	// 修正后自动补写
	model.invalid = false;
	face.edit('waitMs', '1000');
	await new Promise((resolve) => setTimeout(resolve, 30));
	check('J2 修正后自动补写', model.saveCalls === 1 && face.hooks.reviewAutosave.getSnapshot().status === 'saved', `${model.saveCalls}/${face.hooks.reviewAutosave.getSnapshot().status}`);
	I.AUTO.delayMs = 500;
}

{
	// 冲突（第一次被拒）后要能恢复：丢掉草稿清掉过期 revision、重新暂存、再写一次成功。
	const { mod, ctx, captured } = await loadClientBundle({ saveFailures: 1 });
	const I = mod.__internals;
	I.AUTO.delayMs = 5;
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	face.edit('language', 'en');
	await new Promise((resolve) => setTimeout(resolve, 30));
	check('J2 冲突后重试了一次', model.saveCalls === 2, String(model.saveCalls));
	check('J2 冲突恢复靠「丢弃 + 重新暂存」', model.discardCalls === 1, String(model.discardCalls));
	check('J2 恢复后状态回到 saved', face.hooks.reviewAutosave.getSnapshot().status === 'saved', face.hooks.reviewAutosave.getSnapshot().status);
	I.AUTO.delayMs = 500;
}

{
	// 一直失败就如实报 failed，不无限重试。
	const { mod, ctx, captured } = await loadClientBundle({ saveFailures: 99 });
	const I = mod.__internals;
	I.AUTO.delayMs = 5;
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	face.edit('language', 'en');
	await new Promise((resolve) => setTimeout(resolve, 30));
	check('J2 持续失败只重试一次', model.saveCalls === 2, String(model.saveCalls));
	check('J2 持续失败如实报 failed', face.hooks.reviewAutosave.getSnapshot().status === 'failed', face.hooks.reviewAutosave.getSnapshot().status);
	// 手动「立即保存」仍可再试
	face.save();
	await new Promise((resolve) => setTimeout(resolve, 10));
	check('J2 立即保存可手动重试', model.saveCalls >= 3, String(model.saveCalls));
	I.AUTO.delayMs = 500;
}

{
	// 离开页面（SettingsForm 会调 onDiscard）前先把待写的改动落盘，最后几个字不能丢。
	const { mod, ctx, captured } = await loadClientBundle({});
	const I = mod.__internals;
	I.AUTO.delayMs = 5000; // 故意让防抖不会自己触发
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	face.edit('language', 'en');
	check('J2 待写时还未落盘', model.saveCalls === 0);
	face.discard();
	await new Promise((resolve) => setTimeout(resolve, 40));
	check('J2 离开页面前先落盘', model.saveCalls === 1, String(model.saveCalls));
	check('J2 之后才丢弃草稿', model.discardCalls === 1 && model.dirty === false);
	I.AUTO.delayMs = 500;
}

{
	// codex 评审发现的场景：保存还在途中时又编辑，然后立刻离开页面。
	// 官方模型会拒绝并发保存，若此时 discard 清掉草稿，最后那几个字就丢了。
	const { mod, ctx, captured } = await loadClientBundle({ saveDelayMs: 40 });
	const I = mod.__internals;
	I.AUTO.delayMs = 5;
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	face.edit('language', 'en');
	await new Promise((resolve) => setTimeout(resolve, 15)); // 第一次写入在途中
	face.edit('language', 'en-US'); // 落在保存期间
	face.discard(); // 立刻离开页面
	await new Promise((resolve) => setTimeout(resolve, 160));
	check('J2 离开时不丢在途编辑（写了第二轮）', model.saveCalls >= 2, String(model.saveCalls));
	check('J2 离开时草稿已写完才丢弃', model.dirty === false && model.discardCalls === 1, `${model.dirty}/${model.discardCalls}`);
	check('J2 最终状态是 saved', face.hooks.reviewAutosave.getSnapshot().status === 'saved', face.hooks.reviewAutosave.getSnapshot().status);
	I.AUTO.delayMs = 500;
}

{
	// 只读部署：不写、也不假装保存。
	const { mod, ctx, captured } = await loadClientBundle({ writable: false });
	const I = mod.__internals;
	I.AUTO.delayMs = 5;
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	model.dirty = true;
	face.edit('language', 'en');
	await new Promise((resolve) => setTimeout(resolve, 30));
	check('J2 只读部署不写盘', model.saveCalls === 0, String(model.saveCalls));
	check('J2 只读部署状态为 idle', face.hooks.reviewAutosave.getSnapshot().status === 'idle', face.hooks.reviewAutosave.getSnapshot().status);
	I.AUTO.delayMs = 500;
}

{
	// 保存期间又编辑：那几个字不能被漏掉（官方模型在 saving 时会直接挡掉第二次 save）。
	const { mod, ctx, captured } = await loadClientBundle({ saveDelayMs: 40 });
	const I = mod.__internals;
	I.AUTO.delayMs = 5;
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	face.edit('language', 'en');
	await new Promise((resolve) => setTimeout(resolve, 15)); // 第一次写入已在途中
	face.edit('language', 'en-US'); // 落在保存期间
	await new Promise((resolve) => setTimeout(resolve, 120));
	check('J2 保存期间的编辑会再写一轮', model.saveCalls >= 2, String(model.saveCalls));
	check('J2 最终状态是 saved（没有挂着的草稿）', face.hooks.reviewAutosave.getSnapshot().status === 'saved' && model.dirty === false, `${face.hooks.reviewAutosave.getSnapshot().status}/${model.dirty}`);
	I.AUTO.delayMs = 500;
}

{
	// 保存抛异常：状态必须落到 failed，不能永远卡在 saving，而且之后手动保存还能再试。
	const { mod, ctx, captured } = await loadClientBundle({ saveThrows: true });
	const I = mod.__internals;
	I.AUTO.delayMs = 5;
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	face.edit('language', 'en');
	await new Promise((resolve) => setTimeout(resolve, 30));
	check('J2 保存抛异常时状态为 failed', face.hooks.reviewAutosave.getSnapshot().status === 'failed', face.hooks.reviewAutosave.getSnapshot().status);
	check('J2 抛异常也会再重试一次', model.saveCalls === 2, String(model.saveCalls));
	face.save();
	await new Promise((resolve) => setTimeout(resolve, 10));
	check('J2 抛异常后仍可手动再试', model.saveCalls >= 3, String(model.saveCalls));
	I.AUTO.delayMs = 500;
}

{
	// 冲突恢复只重放「用户动过的字段」，不能整表重放（否则可能覆盖别处对其它字段的修改）。
	const { mod, ctx, captured } = await loadClientBundle({ saveFailures: 1 });
	const I = mod.__internals;
	I.AUTO.delayMs = 5;
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	face.edit('language', 'en');
	await new Promise((resolve) => setTimeout(resolve, 30));
	check('J2 冲突恢复只重放动过的字段', [...new Set(model.editLog)].join(',') === 'language', JSON.stringify(model.editLog));
	check('J2 冲突恢复没有重放整表', model.editLog.length <= 3, String(model.editLog.length));
	I.AUTO.delayMs = 500;
}

{
	// 卸载后不该再有写入：待触发的定时器必须先被清掉。
	const { mod, ctx, captured } = await loadClientBundle({});
	const I = mod.__internals;
	I.AUTO.delayMs = 30;
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	face.edit('language', 'en');
	check('J2 卸载前已排了定时器', model.saveCalls === 0);
	for (const dispose of captured.disposers) {
		if (typeof dispose === 'function') dispose();
	}
	await new Promise((resolve) => setTimeout(resolve, 80));
	check('J2 卸载后不再写入', model.saveCalls === 0, String(model.saveCalls));
	I.AUTO.delayMs = 500;
}

{
	// 状态行渲染出来，并且读的是自动保存 store。
	const { mod, ctx, captured } = await loadClientBundle({});
	mod.apply(ctx);
	const model = captured.models[0];
	const face = captured.registrations[0].options.inject();
	const view = { shell: model.shell(), fields: Object.fromEntries(model.specs.map((entry) => [entry.field, model.field(entry.field)])) };
	const element = captured.registrations[0].render({
		view: 'page',
		t: (key) => key,
		...face,
		useReviewConfigForm: (selector) => selector(view),
		useReviewCatalog: (selector) => selector({ status: 'ready', groups: [] }),
		useReviewAutosave: (selector) => selector({ status: 'pending' }),
	});
	const status = findAll(element, (node) => node.props?.className === 'dsh-review-autosave');
	check('J2 状态行渲染在页面上', status.length === 1, String(status.length));
	// 放在表单最前面：打开页面就能看到，不用滚到最底下的保存按钮那里
	const formChildren = findAll(element, (node) => node.type === 'SettingsForm')[0].props.children;
	check('J2 状态行在表单最前面', findAll(formChildren[0], (node) => node.props?.className === 'dsh-review-autosave').length === 1, String(formChildren.length));
	check('J2 状态行带状态与文案', status[0].props['data-state'] === 'pending' && findAll(status[0], (node) => node.props?.children === 'autoPending').length === 1);
	// 保存按钮变成「立即保存」兜底
	const labels = findAll(element, (node) => node.type === 'SettingsForm')[0].props.labels;
	check('J2 保存按钮改成「立即保存」', labels.save === 'saveNow', labels.save);
}

/* ────────────────────────────── K. GUI 配置的宿主半边 ────────────────────────────── */

console.log('\nK. GUI 配置的宿主半边');

{
	const schema = await import(new URL('./lib/schema.js', import.meta.url).href);
	const { resolveSettings } = await import(new URL('./lib/settings.js', import.meta.url).href);

	// volatile 盒子的识别与摊平（纯逻辑，不依赖 schemastery）
	const box = (value) => ({ get: () => value });
	check('K 识别 volatile 盒子', schema.isVolatileBox(box(1)) === true && schema.isVolatileBox({ get: 1 }) === false, 'get 不是函数时不算盒子');
	check('K 普通值/数组/undefined 不算盒子', schema.isVolatileBox([]) === false && schema.isVolatileBox(undefined) === false && schema.isVolatileBox('x') === false);
	check('K 摊平顶层盒子', schema.unwrapConfig({ waitMs: box(1000) }).waitMs === 1000);
	check('K 摊平嵌套盒子', JSON.stringify(schema.unwrapConfig({ discover: { enabled: box(true), providers: box(['bailian']) } })) === JSON.stringify({ discover: { enabled: true, providers: ['bailian'] } }));
	check('K 摊平数组里的盒子', JSON.stringify(schema.unwrapConfig({ defaultReviewers: [box('codex'), 'qwen'] })) === JSON.stringify({ defaultReviewers: ['codex', 'qwen'] }));
	check('K 普通值原样保留', JSON.stringify(schema.unwrapConfig({ modes: { deep: { strength: 'deep' } }, n: 3 })) === JSON.stringify({ modes: { deep: { strength: 'deep' } }, n: 3 }));

	if (schema.Config === undefined) {
		console.log('  skip schemastery 在本机解析不到：只验证「没有 schema 时插件照常工作」');
		check('K 没有 schema 时 Config 为 undefined', schema.Config === undefined);
	} else {
		console.log(`  ok   K 解析到 schemastery，Config 已生成`);
		const Config = schema.Config;
		const config = { agents: [{ preset: 'codex' }], modes: { deep: { strength: 'deep' } }, waitMs: 60000, discover: { providers: ['bailian'] }, 未知键: '保留' };
		const resolved = Config(config);
		check('K schema 接受部分配置（缺省字段不报错）', resolved !== undefined);
		check('K 未声明的键不被丢弃', schema.unwrapConfig(resolved).未知键 === '保留' && Array.isArray(schema.unwrapConfig(resolved).agents), JSON.stringify(Object.keys(schema.unwrapConfig(resolved))));
		check('K 声明的字段是 volatile 盒子', schema.isVolatileBox(resolved.waitMs) === true, typeof resolved.waitMs);
		check('K 声明的嵌套叶子也是盒子', schema.isVolatileBox(resolved.discover?.providers) === true, typeof resolved.discover?.providers);
		check('K 盒子取回原始值', resolved.waitMs.get() === 60000 && JSON.stringify(resolved.discover.providers.get()) === JSON.stringify(['bailian']));
		check('K reviewers/modes 原样透传', JSON.stringify(schema.unwrapConfig(resolved).modes) === JSON.stringify({ deep: { strength: 'deep' } }));
		// 最关键的一条：声明 schema 之后，配置归一化的结果与不声明时完全一致。
		const viaSchema = resolveSettings(schema.unwrapConfig(resolved));
		const direct = resolveSettings(config);
		check('K schema 不改变归一化结果', JSON.stringify({ ...viaSchema, warnings: [] }) === JSON.stringify({ ...direct, warnings: [] }), JSON.stringify(viaSchema.reviewers.length) + ' vs ' + JSON.stringify(direct.reviewers.length));
		// GUI 写入的值同样走这条路
		// GUI 写入的值同样走这条路；被选中的 id 必须真的存在（关掉 adHoc 时未知 id 会被过滤并告警）。
		const edited = resolveSettings(schema.unwrapConfig(Config({ agents: [{ preset: 'codex' }], defaultReviewers: ['codex'], discover: { adHoc: false } })));
		check('K GUI 写入后归一化生效', edited.defaultReviewers.join(',') === 'codex' && edited.discover.adHoc === false, JSON.stringify({ defaultReviewers: edited.defaultReviewers, adHoc: edited.discover.adHoc }));

		// ── 默认值：只给「中性」的键加，且数值必须与插件 DEFAULTS 一致 ──
		const { DEFAULTS } = await import(new URL('./lib/settings.js', import.meta.url).href);
		const meta = (path) => {
			let node = Config;
			for (const key of path) node = node?.dict?.[key];
			return node?.meta ?? {};
		};
		const shared = {
			language: DEFAULTS.language,
			injectPolicy: DEFAULTS.injectPolicy,
			waitMs: DEFAULTS.waitMs,
			hardTimeoutMs: DEFAULTS.hardTimeoutMs,
			maxResultChars: DEFAULTS.maxResultChars,
			maxDiffChars: DEFAULTS.maxDiffChars,
			maxFileDiffChars: DEFAULTS.maxFileDiffChars,
			maxUntrackedFileChars: DEFAULTS.maxUntrackedFileChars,
			maxArgBytes: DEFAULTS.maxArgBytes,
			'discover.include': DEFAULTS.discover.include,
			'discover.exclude': DEFAULTS.discover.exclude,
			'discover.label': DEFAULTS.discover.label,
			'discover.inDefault': DEFAULTS.discover.inDefault,
			'discover.adHoc': DEFAULTS.discover.adHoc,
		};
		const drifted = Object.entries(shared).filter(([path, expected]) => {
			const actual = meta(path.split('.')).default;
			return JSON.stringify(actual) !== JSON.stringify(expected);
		});
		check('K schema 默认值与插件 DEFAULTS 一致', drifted.length === 0, JSON.stringify(drifted.map(([path, expected]) => `${path}: schema=${JSON.stringify(meta(path.split('.')).default)} defaults=${JSON.stringify(expected)}`)));
		// 上了 GUI 之后数组字段永远是 []（schemastery 的隐式默认），所以推断必须按行为验证：
		// 写了 providers / include 就自动打开发现，纯修饰键不打开。
		const enabledOf = (raw) => resolveSettings(schema.unwrapConfig(Config(raw))).discover.enabled;
		check('K 写了 providers 就打开发现', enabledOf({ discover: { providers: ['bailian'] } }) === true);
		check('K 只写修饰键不打开发现', enabledOf({ discover: { adHoc: false } }) === false && enabledOf({ discover: { exclude: ['x*'] } }) === false);
		check('K 空 discover 不打开发现', enabledOf({}).discover === undefined && enabledOf({ discover: {} }) === false);
		check('K 显式 enabled 优先', enabledOf({ discover: { enabled: true } }) === true);
		// 表单打开时数值/开关字段应该有真实值可显示
		check('K 数值与开关默认值可显示', meta(['waitMs']).default === 120000 && meta(['discover', 'adHoc']).default === true && meta(['language']).default === 'auto');
		check('K 硬超时默认 0（不限制）', meta(['hardTimeoutMs']).default === 0);
	}
}

console.log(`\n${passes} 项通过，${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);