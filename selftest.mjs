/**
 * 运行：node selftest.mjs
 *
 * 分区（按此顺序跑）：
 *   A 配置归一化        B 工具描述与参数校验   C CLI 评审者
 *   D LLM 评审者        E 子智能体评审者      F 编排
 *   G 边界              H 回归                I 模型发现与按需指名
 *   J 浏览器半边        J2 自动保存           K GUI 配置的宿主半边
 *   L schema 解析       M 评审状态投影         N 评审状态条
 *
 * 假 ctx 自测：不起宿主进程，也不跑真的 codex / 模型。覆盖
 *
 * - 配置归一化（agents / models / reviewers 展开、非法项降级、模式解析、评审者选择）；
 * - 三种评审者：CLI（argv 拼装 + 结论落盘）、LLM（ctx.llm 流式）、子智能体（ctx.subagents）；
 * - 变更收集：git 摘要、diff 包按需收集、未跟踪文件正文；
 * - 编排：就地返回 / 后台返回 / 纯后台 / 失败收敛 / 汇总 / 截断 / 系统提示词注入；
 * - 评审状态条：job 生命周期 + `turn/*` / `workspace/changes` 折叠、空对话与无改动隐藏。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
		// 范围校验：插件现在会先 rev-parse --verify 确认 base/commit 存在（无效就快速失败）。
		// 用例里用到的 revision 都当作存在；G2 段专门覆盖「不存在」的那条路。
		...['main', 'abc', 'abc123', 'HEAD~1'].map((rev) => ({ argv: ['git', 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`], stdout: `${rev}\n` })),
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
		// spawnError：模拟 git 根本起不来（EACCES / 缺可执行文件），用来验证归因不会跑偏。
		if (typeof matched?.spawnError === 'string') throw new Error(matched.spawnError);
		const stdout = matched?.stdout ?? options.stdout ?? '';
		const stderr = matched?.stderr ?? options.stderr ?? '';
		const exitCode = matched?.exitCode ?? options.exitCode ?? 0;
		// `--output-last-message <path>`：CLI 把结论写进文件。
		const reportFlag = spec.argv.indexOf('--output-last-message');
		const reportPath = reportFlag >= 0 ? spec.argv[reportFlag + 1] : undefined;
		if (reportPath !== undefined && options.report !== undefined && options.skipReportFile !== true) writeFileSync(reportPath, options.report);
		const reader = (text, lossy = false, spillPath = `/spill/${text.length}`) => ({ readFrom: () => ({ text, lossy, nextOffset: text.length, spillPath }) });
		// spawnDelayMs：把评审者做成「慢的」，用来看心跳/超时这类跟时间有关的行为。
		const delay = options.spawnDelayMs ?? 0;
		const done = delay > 0 ? new Promise((resolve) => setTimeout(() => resolve({ exitCode, signal: null }), delay)) : Promise.resolve({ exitCode, signal: null });
		return {
			// stdoutLossy：模拟宿主输出环截断（超过 collectMaxBytes），用来看丢失信息有没有传到结论里。
			collected: { stdout: reader(stdout, options.stdoutLossy === true, options.stdoutSpillPath ?? `/spill/${stdout.length}`), stderr: reader(stderr) },
			done,
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
			async resolveExecutable(command, env) {
				// 用例要模拟「PATH 里没有、只在 profile 里有」时替换掉这条查找。
				if (typeof options.resolveExecutable === 'function') return options.resolveExecutable(command, env);
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
						(record.progressLog ??= []).push(line);
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
	// 生产默认 waitMs = 0（立即交回 job id，交给 job 机制通知）。用例大多想验证「等它跑完」
	// 这条路径，所以这里显式给足等待时间；waitMs 本身的行为另有专门用例。
	if (!('waitMs' in config)) config.waitMs = 60_000;
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
		reviewers: [{ id: 'deep', subagentProvider: 'spawn', agentProvider: 'bailian', agentModel: 'deepseek-v4.1-flash' }],
		defaultReviewers: ['codex', 'nope'],
		modes: {
			quick: { strength: 'light', reviewers: ['claude'], prompt: '只看阻塞问题' },
			strict: { strength: 'deep', reviewers: ['codex', 'deep'], when: 'complex', minChangedLines: 50 },
			broken: { strength: 'nonsense' },
		},
		defaultMode: 'strict',
	});
	const ids = settings.reviewers.map((reviewer) => reviewer.id);
	check('A agents 展开成 cli', settings.reviewers.filter((r) => r.kind === 'cli').map((r) => r.id).join(',') === 'codex,claude', ids.join(','));
	check('A 只支持 cli 与 subagent 两种', settings.reviewers.every((r) => r.kind === 'cli' || r.kind === 'subagent'), settings.reviewers.map((r) => r.kind).join(','));
	check('A reviewers 里的 subagent 推断出 kind', settings.reviewers.find((r) => r.id === 'deep')?.kind === 'subagent');
	// 评审者都是静态定义，写错的 id 当场过滤并告警（没有「调用时才能解析」的 id 了）。
	check('A 未知 defaultReviewers 被过滤', settings.defaultReviewers.join(',') === 'codex', settings.defaultReviewers.join(','));
	check('A 未知 defaultReviewers 有告警', settings.warnings.some((w) => w.includes('nope')), settings.warnings.join('|'));
	// 升级路径：旧配置里的 models / discover 必须点名告警，不能静默让评审者消失
	{
		const legacy = resolveSettings({ models: [{ provider: 'bailian', model: 'qwen3.8-max' }], discover: { providers: ['bailian'] }, reviewers: [{ id: 'a', kind: 'llm', provider: 'b', model: 'm' }] });
		check('A models 已移除时告警', legacy.warnings.some((w) => w.includes('models 已移除')), legacy.warnings.join('|'));
		check('A discover 已移除时告警', legacy.warnings.some((w) => w.includes('discover 已移除')), legacy.warnings.join('|'));
		check('A llm 类型给出专门告警', legacy.warnings.some((w) => w.includes('llm 类型已移除') || w.includes('该类型已移除')), legacy.warnings.join('|'));
		check('A 旧配置不会凭空留下列表', legacy.reviewers.length === 0, JSON.stringify(legacy.reviewers));
	}
	check('A 未知 strength 降级为 standard', settings.modes.broken?.strength === 'standard');
	check('A 未知 strength 有告警', settings.warnings.some((w) => w.includes('nonsense')));
	check('A defaultMode 生效', settings.defaultMode === 'strict');
	check('A resolveMode 默认模式', resolveMode(settings).name === 'strict');
	const selected = selectReviewers(settings, settings.modes.quick, undefined);
	check('A 模式指定评审者优先', selected.map((r) => r.id).join(',') === 'claude', selected.map((r) => r.id).join(','));
	check('A 调用方指定评审者最高优先', selectReviewers(settings, settings.modes.quick, ['codex']).map((r) => r.id).join(',') === 'codex');
	await rejects('A 未知模式报错', () => resolveMode(settings, 'nope'));
	await rejects('A 未知评审者报错', () => selectReviewers(settings, undefined, ['ghost']));
	// 显式传空数组 = 不启用（不能静默落回默认集合），不传才用 mode / defaultReviewers。
	await rejects('A 显式空数组报错', () => selectReviewers(settings, undefined, []));

	// 超时默认不设：评审跑多久由调用方决定，插件不替它掐表。
	check('A 硬超时默认不限制', resolveSettings({}).hardTimeoutMs === 0);
	// 实测评审者要 2～20 分钟，任何「先等一小段」都是白等，所以默认立即交回 job id。
	check('A 前台等待默认 0（立即交回）', resolveSettings({}).waitMs === 0, String(resolveSettings({}).waitMs));
	check('A 子智能体默认有时间上限兜底', resolveSettings({ reviewers: [{ id: 's', kind: 'subagent' }] }).reviewers[0].timeoutMs === 1800000, String(resolveSettings({ reviewers: [{ id: 's', kind: 'subagent' }] }).reviewers[0].timeoutMs));
	// 0.2.1 起 persona / toolFilter 只能由 Agent Preset 组合：不再出现在归一化结果里，
	// 但旧配置必须点名告警（静默失效正是这次 2.0 要避免的）。
	{
		const plain = resolveSettings({ reviewers: [{ id: 's', kind: 'subagent' }] }).reviewers[0];
		check('A 子智能体不再往启动请求塞 toolFilter', plain.toolFilter === undefined);
		check('A 默认不选 agentPreset', plain.agentPreset === undefined);
		const withPreset = resolveSettings({ reviewers: [{ id: 's', kind: 'subagent', agentPreset: 'review-readonly' }] }).reviewers[0];
		check('A agentPreset 原样保留', withPreset.agentPreset === 'review-readonly', String(withPreset.agentPreset));
		const legacyFields = resolveSettings({ reviewers: [{ id: 's', kind: 'subagent', persona: '你是评审者', toolFilter: { deny: ['review'] } }] });
		check('A 旧 persona 有迁移告警', legacyFields.warnings.some((w) => w.includes('persona 已移除')), legacyFields.warnings.join('|'));
		check('A 旧 toolFilter 有迁移告警', legacyFields.warnings.some((w) => w.includes('toolFilter 已移除')), legacyFields.warnings.join('|'));
	}
	// 一个都不选 = 不启用：unset 与 [] 都不是「全部启用」。
	check('A 未勾选时默认集合为空', resolveSettings({ agents: [{ preset: 'codex' }] }).defaultReviewers.length === 0);
	{
		const empty = resolveSettings({ agents: [{ preset: 'codex' }] });
		await rejects('A 未勾选任何评审者时报错', () => selectReviewers(empty, undefined, undefined));
	}

	const bad = resolveSettings({ reviewers: [{ id: 'x', kind: 'llm' }, { id: 'y', kind: 'nope' }] });
	// kind: 'llm' 已经不存在了——写它和写一个乱码 kind 一样会被丢弃并告警。
	check('A 非法/已移除的 kind 被丢弃', bad.reviewers.length === 0 && bad.warnings.length >= 2, `${bad.reviewers.length}/${bad.warnings.length}`);
	await rejects('A 没有评审者时报错清晰', () => selectReviewers(bad, undefined, undefined));
}

/* ────────────────────────────── B. 工具描述与参数校验 ────────────────────────────── */

console.log('\nB. 工具描述与参数校验');
{
	const h = await loadPlugin({
		plugin: {
			agents: [{ preset: 'codex' }, { preset: 'claude' }],
			modes: { deep: { strength: 'deep', description: '彻底评审' } },
		},
	});
	check('B 工具名是 review', h.definition.name === 'review', h.definition.name);
	const description = h.definition.description;
	check('B 描述列出评审者', description.includes('`codex`') && description.includes('`claude`'));
	check('B 描述列出模式', description.includes('`deep`') && description.includes('彻底评审'));
	// 描述必须写清新语义：base/commit 无条件互斥；范围 + 关注点是「按评审者能力有条件放行」，
	// 而不是过去那句「三者最多给一个」——模型按旧文案行事就永远不会尝试 base + instructions。
	check('B 描述写明 base 与 commit 互斥', description.includes('`base` 与 `commit` **互斥**'), description.slice(-700));
	check('B 描述写明范围+关注点按评审者能力有条件放行', description.includes('可以和 `instructions` 同时给') && description.includes('脚注'), description.slice(-700));
	// 旧文案把「写进 mode 的 prompt」当出路，但有范围时模式提示词同样被跳过——那是一条死路。
	check('B 全 CLI 拒绝时不把 mode 提示词当出路', description.includes('写进 `mode` 的提示词同样会被跳过'), description.slice(-700));
	check('B 描述说明 reviewers 只能从列表里选', description.includes('只能从上面列出的评审者里选'));
	check('B 描述说明默认立即返回 job id', description.includes('立即') && description.includes('job_output'));
	{
		const props = h.definition.parameters.properties;
		check('B reviewers 参数列出可选 id', props.reviewers.description.includes('codex') && props.reviewers.description.includes('claude'), props.reviewers.description);
		check('B base/commit 参数说明互斥且可与 instructions 同时给', props.base.description.includes('与 commit 互斥') && props.commit.description.includes('与 base 互斥') && props.base.description.includes('instructions'), props.base.description);
		check('B instructions 参数说明范围+关注点的条件与脚注', props.instructions.description.includes('脚注') && props.instructions.description.includes('subagent'), props.instructions.description);
		check('B instructions 参数说明全 CLI 时直接报错', props.instructions.description.includes('只能留一个'), props.instructions.description);
	}
	check('B 参数含 reviewers/mode/base/commit/instructions/doctor', Object.keys(h.definition.parameters.properties).join(',') === 'reviewers,mode,base,commit,instructions,doctor');
	// 描述里的可用性标注只认「含 / 的绝对路径」：本机事故是 patch 钉死的绝对路径被依赖重装
	// 删掉，而描述仍宣告可用。裸名字走 PATH，不能在解析配置时 stat 成「当前目录下的文件不存在」。
	{
		const missing = await loadPlugin({ plugin: { reviewers: [{ id: 'gone', kind: 'cli', preset: 'codex', executable: '/nope/definitely-gone-bin' }] } });
		check('B 绝对路径不存在时描述里标注', missing.definition.description.includes('⚠️ 可执行文件不存在'), missing.definition.description);
		const bare = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] } });
		check('B 裸名字不误报「不存在」', !bare.definition.description.includes('⚠️'), bare.definition.description);
	}
	check('B presentCall 是 terminal 卡片', h.definition.presentCall({ reviewers: ['codex'], base: 'main' }).title === 'review(codex) --base main');
	// 回归（codex 评审）：卡片标题与 job 标签曾各写一份拼装，job 标签加了 instructions、卡片
	// 没加；而且只标「有没有」不足以区分两条不同的指令。
	{
		const one = h.definition.presentCall({ reviewers: ['codex'], instructions: '只看并发' }).title;
		const two = h.definition.presentCall({ reviewers: ['codex'], instructions: '只看错误处理' }).title;
		check('B presentCall 带上 instructions', one.includes('+instructions「只看并发」'), one);
		check('B 不同 instructions 的卡片标题不同', one !== two, `${one} | ${two}`);
		const prefix = '只看并发与错误处理，忽略所有注释和风格建议，另外不要提性能问题';
		const longOne = h.definition.presentCall({ reviewers: ['codex'], instructions: prefix }).title;
		const longTwo = h.definition.presentCall({ reviewers: ['codex'], instructions: `${prefix}！` }).title;
		check('B 长 instructions 截断后仍可区分', longOne !== longTwo && longOne.includes('#'), `${longOne} | ${longTwo}`);
	}

	await rejects('B 拒绝 base+commit', () => run(h, { base: 'main', commit: 'abc' }));
	// 互斥按「评审者能不能同时收范围与关注点」判：codex 的 CLI 不能（PROMPT 与范围开关互斥），
	// claude 这类不带范围开关的预设则可以。所以用纯 codex 覆盖这条错路。
	{
		const cli = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, report: 'x' } });
		await rejects('B 拒绝 base+instructions（全是不支持二者的 CLI）', () => run(cli, { base: 'main', instructions: 'x' }));
	}
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
	// 未跟踪的 src/b.js 只有 1 行，也计入新增：否则「1 个文件，+0 / -0」看着像没改动。
	check('C 报告含变更规模', value.report.includes('+11 / -2'), value.report.slice(0, 400));
	check('C 未跟踪文件的行数计入新增', value.report.includes('已按 1 行新增计入规模'), value.report.slice(0, 500));
	const argv = h.state.spawns.find((spec) => spec.argv[0] === '/fake/codex').argv;
	// codex 的 CLI 不允许 PROMPT 与范围开关同时出现，而我们现在总会给它统一输出格式，
	// 所以 `--uncommitted` 不再显式传递——codex 不带范围开关时的默认范围就是未提交改动，
	// 与显式传该开关等价；显式 base/commit 时仍然保留范围开关（见 H 段用例）。
	check('C argv 前缀', JSON.stringify(argv.slice(0, 6)) === JSON.stringify(['/fake/codex', 'exec', 'review', '--ephemeral', '-m', 'gpt-x']), JSON.stringify(argv.slice(0, 7)));
	check('C argv 带 --output-last-message', argv.includes('--output-last-message'));
	// 标题里不塞绝对路径
	{
		const heading = value.report.split('\n').find((line) => line.startsWith('###')) ?? '';
		check('C 报告标题不塞绝对路径', heading.includes('（cli, codex') && !heading.includes('/'), heading);
	}
	check('C codex 不喂 diff（needsPacket=false）', !h.state.spawns.some((spec) => spec.argv.includes('--no-color') && spec.argv.includes('diff')), JSON.stringify(h.state.spawns.map((s) => s.argv.slice(0, 5))));
	// 实测 1/5 次：codex 写不出报告文件（Failed to write last message file），但 stdout 里
	// 有完整结论——不能因为文件缺失就白丢一份评审。
	{
		const broken = await loadPlugin({
			plugin: { agents: [{ preset: 'codex' }] },
			harness: { ...GIT, stdout: 'Codex 的完整结论\n\n<details>诊断输出</details>', skipReportFile: true },
		});
		const fallback = await run(broken, {});
		check('C 报告文件缺失时回退 stdout', fallback.report.includes('Codex 的完整结论'), fallback.report.slice(0, 300));
		check('C 回退时剥掉诊断块', !fallback.report.includes('<details>诊断输出</details>'));
		check('C 回退写进材料说明', fallback.report.includes('从 stdout 回退提取'), fallback.report.slice(-500));
	}
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
	check('C PROMPT 前有 -- 终止符', argv.at(-2) === '--' && argv.at(-1).startsWith('--focus on concurrency'), JSON.stringify(argv.slice(-2)));
	// codex 也要拿到统一输出格式，否则一份报告里两种体例
	check('C PROMPT 带统一输出格式', argv.at(-1).includes('### 输出格式') && argv.at(-1).includes('## 问题'), argv.at(-1));
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

/* ────────────────────────────── E. 子智能体评审者 ────────────────────────────── */

console.log('\nE. 子智能体评审者');
{
	const subagentCalls = [];
	const services = {
		subagents: {
			getProvider: (name) => (name === 'spawn' ? { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } } : undefined),
			resolveMaxDepth: (depth) => depth,
			async startActivation(spec) {
				subagentCalls.push(spec);
				return {
					childId: 'child-1',
					result: Promise.resolve({ output: [{ type: 'text', text: '子智能体结论：没发现问题。' }], stopReason: 'completed' }),
					dispose: async () => {},
				};
			},
		},
	};
	const h = await loadPlugin({
		plugin: { reviewers: [{ id: 'deep', kind: 'subagent', provider: 'spawn', agentProvider: 'bailian', agentModel: 'deepseek-v4.1-flash', maxDepth: 1, agentPreset: 'review-readonly' }] },
		harness: { ...GIT, services },
	});
	const value = await run(h, {});
	check('E 子智能体结论进报告', value.report.includes('子智能体结论'), value.report.slice(0, 300));
	check('E 用 startActivation 的 spec 形状', subagentCalls[0].provider === 'spawn' && subagentCalls[0].label === 'review:deep' && subagentCalls[0].delivery === 'caller' && subagentCalls[0].signal instanceof AbortSignal, JSON.stringify({ provider: subagentCalls[0].provider, label: subagentCalls[0].label, delivery: subagentCalls[0].delivery }));
	check('E label/signal 不再塞进 request', !('label' in subagentCalls[0].request) && !('signal' in subagentCalls[0].request));
	check('E 传了 provider 与 model', subagentCalls[0].request.agentOptions.provider === 'bailian' && subagentCalls[0].request.agentOptions.model === 'deepseek-v4.1-flash');
	check('E 传了 parent 与 agentPreset', subagentCalls[0].request.parent.id === 'agent-1' && subagentCalls[0].request.agentPreset === 'review-readonly');
	check('E 提示词里有评审包', subagentCalls[0].request.prompt[0].text.includes('评审任务'));
}
{
	// 0.1.x 只有 start()：要么明确报版本，要么让人看到 `start is not a function`。
	const h = await loadPlugin({
		plugin: { reviewers: [{ id: 'deep', kind: 'subagent', provider: 'spawn' }] },
		harness: { ...GIT, services: { subagents: { getProvider: () => ({ name: 'spawn' }) } } },
	});
	const value = await run(h, {});
	check('E 旧宿主缺少 startActivation 时明确报版本', value.report.includes('startActivation') && value.report.includes('0.2.1'), value.report.slice(0, 500));
}
{
	// 0.2.1 的 signal 只管启动前取消：发布后必须 dispose 才能真正停掉子智能体。
	let disposed = 0;
	const services = {
		subagents: {
			getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } }),
			resolveMaxDepth: (depth) => depth,
			async startActivation() {
				let settle;
				const result = new Promise((resolve) => {
					settle = resolve;
				});
				return {
					childId: 'child-hang',
					result,
					async dispose() {
						disposed += 1;
						settle({ output: [], stopReason: 'aborted' });
					},
				};
			},
		},
	};
	const keepAlive = setInterval(() => {}, 10);
	try {
		const h = await loadPlugin({ plugin: { reviewers: [{ id: 'deep', kind: 'subagent', provider: 'spawn', timeoutMs: 20 }] }, harness: { ...GIT, services } });
		const value = await run(h, {});
		check('E 超时后 dispose 停掉子智能体', disposed === 1, `disposed=${disposed}`);
		check('E 超时报告仍指向 timeoutMs', value.report.includes('被该评审者的 `timeoutMs` 中止'), value.report.slice(-600));
	} finally {
		clearInterval(keepAlive);
	}
}
{
	const h = await loadPlugin({ plugin: { reviewers: [{ id: 'deep', kind: 'subagent' }] }, harness: { ...GIT } });
	const value = await run(h, {});
	check('E 缺 ctx.subagents 时给出说明', value.report.includes('ctx.subagents 服务不可用'));
}

/* ────────────────────────────── F. 编排 ────────────────────────────── */

console.log('\nF. 编排');
{
	// 多评审者：两个 CLI 智能体各评一遍，报告里各一节。
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }, { preset: 'claude' }] },
		harness: { ...GIT, report: 'Codex 结论' },
	});
	const value = await run(h, {});
	check('F 多评审者都出现', value.report.includes('`codex`') && value.report.includes('`claude`'), value.report.slice(0, 300));
	check('F reviewers 字段回填', value.reviewers.join(',') === 'codex,claude', JSON.stringify(value.reviewers));
	check('F status=completed', value.status === 'completed', value.detail);
	check('F job 已移除', h.state.jobs.size === 0);
}
{
	// 进度心跳：子智能体可能跑 20 分钟以上且中间没有输出，调用方至少要看出「还在跑」。
	{
		const mod = await import(PLUGIN);
		mod.__internals.heartbeatMs = 15;
		const hb = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, wait: 'running', report: 'x', spawnDelayMs: 60 } });
		await run(hb, {});
		const rec = hb.state.jobs.get('review-1');
		await new Promise((resolve) => setTimeout(resolve, 70));
		await rec.settledPromise;
		const lines = rec.progressLog ?? [];
		check('F 进度有初始行', lines[0] === 'reviewing (codex)', JSON.stringify(lines));
		check('F 进度有心跳（含仍在跑的评审者与用时）', lines.some((line) => /^reviewing \(codex\) — \d+m\d\ds$/.test(line)), JSON.stringify(lines.slice(1)));
		check('F 心跳不止一次', lines.filter((line) => line.includes('—')).length >= 2, String(lines.filter((line) => line.includes('—')).length));
		mod.__internals.heartbeatMs = 30_000;
	}
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
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }, { preset: 'gemini' }] },
		harness: {
			...GIT,
			report: 'Codex 结论',
			gitScript: defaultGitScript(WORK),
		},
	});
	// gemini 用 stdout capture，返回空 → failed。
	const value = await run(h, {});
	check('F 部分失败仍是 completed', value.kind === 'completed' && value.status === 'completed', JSON.stringify(value).slice(0, 200));
	// 失败不能只埋在分节标题里：报告头要给出「几个成功 / 几个失败」。
	check('F 报告头给出成功/失败统计', value.report.includes('1 成功 / 1 失败'), value.report.slice(0, 400));
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
		plugin: { agents: [{ preset: 'codex' }] },
		harness: { ...GIT, report: '结论', gitScript: [{ argv: ['git', 'rev-parse', '--is-inside-work-tree'], exitCode: 128, stderr: 'not a git repository' }] },
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
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, gitScript: clean, report: '结论' } });
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

/* ────────────────────────────── G2. 范围校验（快速失败） ────────────────────────────── */

console.log('\nG2. 范围校验');
{
	// 实测：base 写成不存在的分支时，git 先失败（只记 note），照样花 140 秒起 codex，
	// 最后报 completed 却什么都没评。现在起 job 之前就校验。
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: {
			...GIT,
			report: 'x',
			gitScript: [...defaultGitScript(WORK), { argv: ['git', 'rev-parse', '--verify', '--quiet', 'no-such-branch-xyz^{commit}'], exitCode: 1 }],
		},
	});
	const dirsBefore = countWorkDirs();
	await rejects('G2 无效 base 快速失败', () => run(h, { base: 'no-such-branch-xyz' }));
	check('G2 无效 base 没有起评审者', h.state.spawns.every((spec) => spec.argv[0] !== '/fake/codex'), JSON.stringify(h.state.spawns.map((s) => s.argv[0])));
	check('G2 无效 base 没有建临时目录', countWorkDirs() === dirsBefore, `${dirsBefore} → ${countWorkDirs()}`);
}
{
	// 回归（codex 评审）：git 跑不起来 / 调用被取消 / 仓库坏了，与「revision 真的不存在」
	// 以前被压成同一句「不是一个有效的分支或提交」，会把排查引向错误方向；取消更会静默继续
	// （默认 waitMs=0 时后续 job 用独立 controller，不继承这里的信号）。
	const probeArgv = ['git', 'rev-parse', '--is-inside-work-tree'];
	const verifyArgv = (rev) => ['git', 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`];

	// 真实 git 的行为：找不到 → 退出码 1 且 stderr 为空；执行错误 → 128 + fatal 文案。
	const notFound = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: { ...GIT, report: 'x', gitScript: [verifyArgv('main'), { argv: verifyArgv('main'), exitCode: 1 }, ...defaultGitScript(WORK)] },
	});
	const notFoundError = await rejects('G2 revision 不存在仍然快速失败', () => run(notFound, { base: 'main' }));
	check('G2 revision 不存在时明确说找不到', String(notFoundError?.message).includes('不是一个有效的分支或提交'), String(notFoundError?.message));

	const spawnBroken = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: { ...GIT, report: 'x', gitScript: [{ argv: probeArgv, spawnError: 'spawn git EACCES' }, ...defaultGitScript(WORK)] },
	});
	const spawnError = await rejects('G2 git 起不来时也快速失败', () => run(spawnBroken, { base: 'main' }));
	check('G2 git 起不来时报「无法运行 git」而不是分支不存在', String(spawnError?.message).includes('无法运行 git') && !String(spawnError?.message).includes('不是一个有效的分支或提交'), String(spawnError?.message));

	const fatal = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: { ...GIT, report: 'x', gitScript: [{ argv: verifyArgv('main'), exitCode: 128, stderr: 'fatal: unable to read tree\n' }, ...defaultGitScript(WORK)] },
	});
	const fatalError = await rejects('G2 仓库坏了时也快速失败', () => run(fatal, { base: 'main' }));
	check('G2 执行错误带上真实原因与退出码', String(fatalError?.message).includes('fatal: unable to read tree') && String(fatalError?.message).includes('128'), String(fatalError?.message));

	const aborted = new AbortController();
	aborted.abort();
	const cancelled = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, report: 'x' } });
	const cancelError = await rejects('G2 已取消的调用立即终止', () =>
		run(cancelled, { base: 'main' }, { agent: { id: 'agent-1', session: { header: { cwd: WORK } } }, signal: aborted.signal }),
	);
	check('G2 取消时报「已取消」而不是分支不存在', String(cancelError?.message).includes('已取消'), String(cancelError?.message));

	// 对照：非 git 目录仍然由 collectChanges 说明，不冒充「分支不存在」。
	const noRepo = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: { ...GIT, report: '结论', gitScript: [{ argv: probeArgv, exitCode: 128, stderr: 'fatal: not a git repository' }] },
	});
	const noRepoValue = await run(noRepo, { base: 'main' });
	check('G2 非 git 目录不报「分支不存在」', !noRepoValue.report.includes('不是一个有效的分支或提交') && noRepoValue.report.includes('不是 git 仓库'), noRepoValue.report.slice(0, 400));

	// 回归（codex 验收）：探测本身异常退出（dubious ownership / 权限 / 仓库损坏）也是
	// 128 + stderr，不能当成「不是仓库」——那会让调用方以为这里本来就没得评，照样白起一轮。
	const dubious = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: { ...GIT, report: 'x', gitScript: [{ argv: probeArgv, exitCode: 128, stderr: 'fatal: detected dubious ownership in repository at /x\n' }, ...defaultGitScript(WORK)] },
	});
	const dubiousError = await rejects('G2 探测异常退出时也快速失败', () => run(dubious, { base: 'main' }));
	check('G2 探测异常退出保留退出码与 stderr', String(dubiousError?.message).includes('dubious ownership') && String(dubiousError?.message).includes('128'), String(dubiousError?.message));

	const dubiousNoRange = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: { ...GIT, report: '结论', gitScript: [{ argv: probeArgv, exitCode: 128, stderr: 'fatal: detected dubious ownership in repository at /x\n' }, ...defaultGitScript(WORK)] },
	});
	const dubiousValue = await run(dubiousNoRange, {});
	check('G2 无范围时探测异常也带真实原因', dubiousValue.report.includes('dubious ownership'), dubiousValue.report.slice(0, 500));
	check('G2 无范围时探测异常不冒充「不是仓库」', !dubiousValue.report.includes('工作目录不是 git 仓库'), dubiousValue.report.slice(0, 500));
}

/* ────────────────────────────── G3. 范围 + 关注点 ────────────────────────────── */

console.log('\nG3. 范围 + 关注点');
{
	// subagent 能同时收范围和关注点；codex 这类 CLI 不能（PROMPT 与范围开关互斥）。
	const subagentCalls = [];
	const subServices = {
		subagents: {
			getProvider: (name) => (name === 'spawn' ? { name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } } : undefined),
			resolveMaxDepth: (depth) => depth,
			async startActivation(spec) {
				subagentCalls.push(spec);
				return { childId: 'child-g3', result: Promise.resolve({ output: [{ type: 'text', text: '子智能体结论' }], stopReason: 'completed' }), dispose: async () => {} };
			},
		},
	};
	const sub = await loadPlugin({
		plugin: { reviewers: [{ id: 'sub', kind: 'subagent', provider: 'spawn' }], defaultReviewers: ['sub'], modes: { deep: { strength: 'deep' } } },
		harness: { ...GIT, services: subServices },
	});
	const value = await run(sub, { base: 'main', instructions: '只看并发' });
	check('G3 子智能体允许范围 + 关注点', value.status === 'completed', JSON.stringify(value).slice(0, 200));
	const prompt = subagentCalls[0]?.request.prompt[0].text ?? '';
	check('G3 关注点真的传给了子智能体', prompt.includes('只看并发'), prompt.slice(0, 200));

	// 全部都是 CLI 时才报错，且错误里点名是哪些评审者；给出的出路必须是真能走通的
	// （去掉范围 / 去掉关注点 / 加 subagent）——旧文案推荐「写进 mode 的 prompt」，
	// 但有范围时模式提示词同样会被跳过，等于让调用方再撞一次。
	const cli = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, report: 'x' } });
	const cliError = await rejects('G3 全是 CLI 时范围 + 关注点报错', () => run(cli, { base: 'main', instructions: '只看并发' }));
	check(
		'G3 报错给出可行出路',
		cliError !== undefined && cliError.message.includes('codex') && cliError.message.includes('subagent') && cliError.message.includes('去掉 base/commit') && cliError.message.includes('也不行'),
		String(cliError?.message),
	);

	// 混合集合：放行，并在材料说明里点名没收到关注点的那个。
	const mixed = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }], reviewers: [{ id: 'sub', kind: 'subagent', provider: 'spawn' }] },
		harness: { ...GIT, report: 'x', services: subServices },
	});
	const out = await run(mixed, { base: 'main', instructions: '只看并发' });
	check('G3 混合集合放行', out.status === 'completed', JSON.stringify(out).slice(0, 160));
	check('G3 材料说明点名 CLI 没收到关注点', out.report.includes('instructions没有传递给它们') || out.report.includes('instructions 没有传递给它们'), out.report.slice(-600));
}

/* ────────────────────────────── G4. 假脚注 ────────────────────────────── */

console.log('\nG4. 假脚注');
{
	// 没配任何模式、也没给 instructions 时，不该出现「提示词没有传递」的脚注。
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, report: 'x' } });
	const value = await run(h, { base: 'main' });
	check('G4 没有任何提示词时不报「没有传递」', !value.report.includes('没有传递'), value.report.slice(-500));
	// 真给了模式提示词时才报（这条走的是 mode 的 prompt，不是 instructions）。
	const withPrompt = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }], modes: { deep: { strength: 'deep' } } },
		harness: { ...GIT, report: 'x' },
	});
	const out = await run(withPrompt, { base: 'main', mode: 'deep' });
	check('G4 真有模式提示词时才报', out.report.includes('模式的提示词没有传递'), out.report.slice(-600));
}

/* ────────────────────────────── G5. 环境自检（doctor） ────────────────────────────── */

console.log('\nG5. 环境自检');
{
	// 定位成功：报出解析到的路径、来源与版本；不起评审者、不需要 git 仓库。
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: { cwd: WORK, gitScript: [], stdout: 'codex-cli 9.9.9\n', resolveExecutable: async (command) => (command.includes('/') ? command : `/fake/${command}`) },
	});
	const value = await run(h, { doctor: true });
	check('G5 doctor 返回 completed', value.kind === 'completed' && value.status === 'completed', JSON.stringify(value).slice(0, 160));
	check('G5 doctor 报出定位路径与来源', value.report.includes('/fake/codex') && value.report.includes('来源：'), value.report);
	check('G5 doctor 报出版本', value.report.includes('codex-cli 9.9.9'), value.report);
	check('G5 doctor 不起评审者', !h.state.spawns.some((spec) => spec.argv[1] === 'exec'), JSON.stringify(h.state.spawns.map((s) => s.argv.slice(0, 2))));
	check('G5 doctor 不碰 git', !h.state.spawns.some((spec) => spec.argv[0] === 'git'), JSON.stringify(h.state.spawns.map((s) => s.argv.slice(0, 2))));
}
{
	// 定位失败 + 子智能体 provider 已注册：失败要给处理办法，别只说「不行」。
	const h = await loadPlugin({
		plugin: {
			reviewers: [
				{ id: 'gone', kind: 'cli', preset: 'codex', executable: '/nope/gone-bin' },
				{ id: 'deep', kind: 'subagent', provider: 'spawn', agentProvider: 'bailian', agentModel: 'm1' },
			],
		},
		harness: {
			...GIT,
			services: { subagents: { startActivation: async () => { throw new Error('doctor 不应启动子智能体'); }, getProvider: (name) => (name === 'spawn' ? { name, capabilities: { agentOptions: true, agentPreset: true } } : undefined) } },
			resolveExecutable: async (command) => {
				if (!command.includes('/')) throw new Error('not found in PATH');
				if (!existsSync(command)) throw new Error('not an executable file');
				return command;
			},
		},
	});
	const value = await run(h, { doctor: true });
	check('G5 doctor 报出定位失败', value.report.includes('定位：❌') && value.report.includes('/nope/gone-bin'), value.report);
	check('G5 doctor 给出处理办法', value.report.includes('直接依赖'), value.report);
	check('G5 doctor 检查 subagent provider', value.report.includes('provider `spawn`：✅ 已注册'), value.report);
	check('G5 doctor 检查 startActivation 接口', value.report.includes('启动接口：✅ `startActivation()`'), value.report);
	check('G5 doctor 说明未做连通性测试', value.report.includes('未做连通性测试'), value.report);
}
{
	// 旧宿主：provider 在、但服务没有 startActivation——自检必须当场报出来。
	const h = await loadPlugin({
		plugin: { reviewers: [{ id: 'deep', kind: 'subagent', provider: 'spawn' }] },
		harness: { ...GIT, services: { subagents: { getProvider: () => ({ name: 'spawn' }) } } },
	});
	const value = await run(h, { doctor: true });
	check('G5 doctor 报出缺少 startActivation', value.report.includes('启动接口：❌') && value.report.includes('0.2.1'), value.report);
}
{
	// provider 没注册：明确 ❌，而不是让人以为配置没问题。
	const h = await loadPlugin({
		plugin: { reviewers: [{ id: 'deep', kind: 'subagent', provider: 'spawn' }] },
		harness: { ...GIT, services: { subagents: { getProvider: () => undefined } } },
	});
	const value = await run(h, { doctor: true });
	check('G5 doctor 报出 provider 未注册', value.report.includes('❌ 没有注册'), value.report);
}
{
	// 一个评审者都没有时，doctor 恰恰最有用——不能先撞上「没有启用任何评审者」的错误。
	const h = await loadPlugin({ plugin: { reviewers: [] } });
	const value = await run(h, { doctor: true });
	check('G5 没有评审者时 doctor 仍可用', value.status === 'completed' && value.report.includes('没有启用任何评审者'), value.report.slice(0, 400));
}
{
	// 回归（codex 验收）：doctor 用空环境定位，而真实执行用的是 envPassthrough 白名单——
	// PATH 靠透传传入的部署里，自检会把「真跑得起来」的 CLI 报成没装。
	// 两层白名单（settings 级 + reviewer 级）都要生效，`--version` 那次 spawn 也要带同一份环境。
	process.env.DSH_REVIEW_TEST_PATH = '/custom/bin';
	process.env.DSH_REVIEW_TEST_REVIEWER = '/reviewer/bin';
	try {
		const h = await loadPlugin({
			plugin: {
				envPassthrough: ['DSH_REVIEW_TEST_PATH'],
				reviewers: [{ id: 'codex', kind: 'cli', preset: 'codex', envPassthrough: ['DSH_REVIEW_TEST_REVIEWER'] }],
			},
			harness: {
				cwd: WORK,
				gitScript: [],
				stdout: 'codex-cli 1.2.3\n',
				resolveExecutable: async (command, env) => {
					if (env?.DSH_REVIEW_TEST_PATH === '/custom/bin' && env?.DSH_REVIEW_TEST_REVIEWER === '/reviewer/bin') return '/custom/bin/codex';
					throw new Error(`not found in PATH (env=${JSON.stringify(env)})`);
				},
			},
		});
		const value = await run(h, { doctor: true });
		check('G5 doctor 定位用两层透传白名单', value.report.includes('/custom/bin/codex'), value.report);
		const versionSpawn = h.state.spawns.find((spec) => spec.argv[1] === '--version');
		check('G5 doctor 的 --version 也带同一份环境', versionSpawn?.env?.DSH_REVIEW_TEST_PATH === '/custom/bin' && versionSpawn?.env?.DSH_REVIEW_TEST_REVIEWER === '/reviewer/bin', JSON.stringify(versionSpawn?.env));
	} finally {
		delete process.env.DSH_REVIEW_TEST_PATH;
		delete process.env.DSH_REVIEW_TEST_REVIEWER;
	}
}

/* ────────────────────────────── H. 回归（真实评审发现的问题） ────────────────────────────── */

console.log('\nH. 回归');
{
	// 未跟踪目录要用 -uall 展开成文件，并且路径按仓库根解析（不是 cwd）。
	// 用 stdin 投递的自定义 CLI 评审者，好从它收到的正文里看评审包。
	const statusArgv = h => h.state.spawns.filter((spec) => spec.argv.includes('status')).map((spec) => spec.argv.join(' '));
	const h = await loadPlugin({
		plugin: { reviewers: [{ id: 'my', kind: 'cli', command: ['{exe}'], executable: 'myreview', promptVia: 'stdin', capture: 'stdout' }], defaultReviewers: ['my'] },
		harness: { ...GIT, stdout: '结论' },
	});
	await run(h, {});
	check('H status 用 -uall', statusArgv(h).some((argv) => argv.includes('-uall')), statusArgv(h).join('|'));
	check('H 解析仓库根', h.state.spawns.some((spec) => spec.argv.join(' ') === 'git rev-parse --show-toplevel'));
	// 评审包正文喂给会读包的 CLI 评审者，从它的 stdin 里看。
	const packet = h.state.spawns.map((spec) => spec.stdio?.stdin?.data ?? '').join('\n');
	check('H 未跟踪文件按仓库根路径读到正文', packet.includes('export const b = 2;'), packet.slice(-300));
}
{
	// 回归（codex 评审）：未跟踪文件的**行数统计**曾按 cwd 解析路径。porcelain 的路径一律
	// 相对仓库根，子目录会话下会拼成 <cwd>/src/b.js 而读不到，规模静默显示成 +0。
	const subdir = join(WORK, 'src');
	const script = defaultGitScript(subdir).map((entry) =>
		entry.argv.join(' ') === 'git rev-parse --show-toplevel' ? { ...entry, stdout: `${WORK}\n` } : entry,
	);
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: { cwd: subdir, gitScript: script, report: '结论' },
	});
	const value = await run(h, {});
	check('H 子目录会话：未跟踪行数按仓库根解析', value.report.includes('已按 1 行新增计入规模'), value.report.slice(0, 400));
}
{
	// 回归（codex 评审）：未跟踪文件的正文曾整份 `readFileSync` 进内存来数行——一个没被
	// 忽略的大文件就能卡死宿主事件循环，连评审者的超时定时器都跑不起来。统计现在有字节
	// 上限，读不全就把行数标成「至少 N」，而不是假装精确。
	const huge = join(WORK, 'huge.txt');
	const HUGE_LINES = 200_000;
	writeFileSync(huge, 'x\n'.repeat(HUGE_LINES));
	const script = defaultGitScript(WORK).map((entry) =>
		entry.argv.includes('status') ? { ...entry, stdout: ' M src/a.js\0?? src/b.js\0?? huge.txt\0' } : entry,
	);
	try {
		const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { cwd: WORK, gitScript: script, report: '结论' } });
		const value = await run(h, {});
		const matched = value.report.match(/已按至少 (\d+) 行新增计入规模/);
		check('H 超大未跟踪文件：行数标成「至少」', matched !== null, value.report.slice(0, 500));
		const counted = matched === null ? Number.NaN : Number.parseInt(matched[1], 10);
		check('H 超大未跟踪文件：只统计上限内的字节', Number.isFinite(counted) && counted > 0 && counted < HUGE_LINES, String(counted));
	} finally {
		rmSync(huge, { force: true });
	}
}
{
	// 回归（codex 验收）：二进制文件检测到 NUL 就 continue，读过的字节没计入**总**预算——
	// 一堆未跟踪的二进制产物每个都能读满单文件上限，总量限制形同虚设。
	const binDir = join(WORK, 'bin-artifacts');
	mkdirSync(binDir, { recursive: true });
	const blob = Buffer.alloc(300 * 1024, 0); // 全 NUL：首块即判为二进制
	const binaries = [];
	for (let index = 0; index < 20; index += 1) {
		writeFileSync(join(binDir, `blob-${index}.bin`), blob);
		binaries.push(`bin-artifacts/blob-${index}.bin`);
	}
	writeFileSync(join(binDir, 'tail.txt'), 'l1\nl2\nl3\nl4\nl5\n');
	const script = defaultGitScript(WORK).map((entry) =>
		entry.argv.includes('status') ? { ...entry, stdout: ` M src/a.js\0?? ${binaries.join('\0?? ')}\0?? bin-artifacts/tail.txt\0` } : entry,
	);
	try {
		const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { cwd: WORK, gitScript: script, report: '结论' } });
		const value = await run(h, {});
		// 20 × 256 KiB = 5 MiB > 4 MiB 预算：二进制把预算吃光，后面的 tail.txt 不再被读。
		// 旧实现不记账，会一路读到 tail.txt 并把它的 5 行算进规模（+15 而不是 +10）。
		check('H 二进制文件也计入读取总预算', value.report.includes('+10 / -2'), value.report.slice(0, 400));
		check('H 预算吃光后不再统计后续文件', !value.report.includes('已按'), value.report.slice(0, 400));
	} finally {
		rmSync(binDir, { recursive: true, force: true });
	}
}
{
	// 回归（codex 评审）：可执行文件只在 PATH 与四个固定目录里找，于是只能把 profile 里的
	// 绝对路径写进 patch——依赖一重装就静默断链（本机事故）。现在按 preset 的 package 在
	// **当前 profile** 里兜底定位，锚点只认宿主给的 profileContext。
	const profileDir = join(WORK, 'fake-profile');
	mkdirSync(join(profileDir, 'node_modules', '.bin'), { recursive: true });
	writeFileSync(join(profileDir, 'node_modules', '.bin', 'codex'), '#!/bin/sh\n');
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: {
			...GIT,
			report: '结论',
			services: { profileContext: { dir: profileDir } },
			// 模拟真实情况：PATH 里没有 codex，绝对路径必须真的存在才认。
			resolveExecutable: async (command) => {
				if (!command.includes('/')) throw new Error('not found in PATH');
				if (!existsSync(command)) throw new Error('not an executable file');
				return command;
			},
		},
	});
	const value = await run(h, {});
	const argv = h.state.spawns.find((spec) => spec.argv[0].endsWith('codex'))?.argv ?? [];
	check('H 按包名在 profile 的 .bin 里定位 CLI', argv[0] === join(profileDir, 'node_modules', '.bin', 'codex'), String(argv[0]));
	check('H 包定位成功后照常出结论', value.status === 'completed', JSON.stringify(value).slice(0, 200));
}
{
	// 包内 bin 子路径是第二候选：.bin 入口缺失（非 npm/pnpm 安装、或只有包目录）时仍要能找到。
	// 同时锁定「不能解析包根」——@openai/codex 没有模块入口，解析包根必失败。
	const profileDir = join(WORK, 'fake-profile-2');
	mkdirSync(join(profileDir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
	writeFileSync(join(profileDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '// codex\n');
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: {
			...GIT,
			report: '结论',
			services: { profileContext: { dir: profileDir } },
			resolveExecutable: async (command) => {
				if (!command.includes('/')) throw new Error('not found in PATH');
				if (!existsSync(command)) throw new Error('not an executable file');
				return command;
			},
		},
	});
	const value = await run(h, {});
	const argv = h.state.spawns.find((spec) => spec.argv[0].endsWith('codex.js'))?.argv ?? [];
	check('H 包内 bin 子路径兜底定位', argv[0] === join(profileDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), String(argv[0]));
	check('H 包内 bin 定位成功后照常出结论', value.status === 'completed', JSON.stringify(value).slice(0, 200));
}
{
	// 锚点不可信就不该用：没有 profileContext 时，不得到工作目录（或其他 profile）里乱找。
	const rogue = join(WORK, 'node_modules', '.bin');
	mkdirSync(rogue, { recursive: true });
	writeFileSync(join(rogue, 'codex'), '#!/bin/sh\n');
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: {
			...GIT,
			report: '结论',
			resolveExecutable: async (command) => {
				if (!command.includes('/')) throw new Error('not found in PATH');
				if (!existsSync(command)) throw new Error('not an executable file');
				return command;
			},
		},
	});
	const value = await run(h, {});
	const argv = h.state.spawns.find((spec) => spec.argv[0].endsWith('codex'))?.argv ?? [];
	check('H 没有 profileContext 时不从工作目录找 CLI', argv.length === 0 && value.status === 'failed', String(argv[0]));
	check('H 找不到时说明 fell back 的尝试过哪些路径', value.report.includes('找不到可执行文件') && value.report.includes('package'), value.report.slice(0, 300));
}
{
	// 回归（codex 评审）：gitFailed 以前只有 numstat 循环置位。status 失败时既不置位也不记
	// note，numstat 恰好 0 文件就会报「未检测到需要评审的改动」——git 坏了却报告没东西可评。
	const clean = [
		{ argv: ['git', 'rev-parse', '--is-inside-work-tree'], stdout: 'true\n' },
		{ argv: ['git', 'rev-parse', '--show-toplevel'], stdout: `${WORK}\n` },
	];
	const broken = [
		...clean,
		{ argv: ['git', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '-uall'], stdout: '', stderr: 'fatal: index file corrupt\n', exitCode: 128 },
	];
	const h = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, gitScript: broken, report: '结论' } });
	const value = await run(h, {});
	check('H git status 失败时不报「没有改动可评」', !value.report.includes('未检测到需要评审的改动'), value.report.slice(0, 500));
	check('H git status 失败记进材料说明', value.report.includes('`git status` 失败') && value.report.includes('index file corrupt'), value.report.slice(0, 700));
	check('H git status 失败仍然照常评审', value.report.includes('结论'), value.report.slice(0, 500));

	// 对照：同样的「无改动」脚本但 status 正常，必须仍然短路（别把短路一起改坏）。
	const ok = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, gitScript: [...clean, { argv: ['git', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '-uall'], stdout: '' }], report: '结论' } });
	const okValue = await run(ok, {});
	check('H git 正常且无改动时仍短路', okValue.report.includes('未检测到需要评审的改动'), okValue.report.slice(0, 300));
}
{
	// 回归（codex 评审）：心跳 setInterval 只在成功路径 clearInterval；空改动短路与失败路径
	// 会漏掉，interval 一直持有 job 引用并对已结算的 job 写进度。用 spy 盯住两个全局函数。
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	let created = 0;
	let cleared = 0;
	globalThis.setInterval = (...args) => {
		created += 1;
		return realSetInterval(...args);
	};
	globalThis.clearInterval = (handle) => {
		cleared += 1;
		return realClearInterval(handle);
	};
	try {
		const clean = [
			{ argv: ['git', 'rev-parse', '--is-inside-work-tree'], stdout: 'true\n' },
			{ argv: ['git', 'rev-parse', '--show-toplevel'], stdout: `${WORK}\n` },
			{ argv: ['git', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '-uall'], stdout: '' },
		];
		const shortCircuit = await loadPlugin({ plugin: { agents: [{ preset: 'codex' }] }, harness: { ...GIT, gitScript: clean, report: '结论' } });
		created = 0;
		cleared = 0;
		await run(shortCircuit, {});
		check('H 空改动短路时也停掉心跳', created === 1 && cleared === 1, `created=${created} cleared=${cleared}`);

		const failing = await loadPlugin({
			plugin: { reviewers: [{ id: 'ghostbin', kind: 'cli', preset: 'custom', executable: 'no-such-bin-xyz', command: ['{exe}', '{prompt}'] }] },
			harness: { ...GIT },
		});
		created = 0;
		cleared = 0;
		await run(failing, {});
		// 注意：这条在旧实现下也通过——评审者失败走的是正常收尾（内联 clearInterval 会执行），
		// 真正泄漏的是上面那条短路路径。catch 路径目前没有可达的触发点（try 内所有可能抛的
		// await 都带 .catch），移到 finally 是为了让「所有出口」这条不变量由结构保证而不是靠枚举。
		check('H 评审者失败后也不留下心跳', created === 1 && cleared === 1, `created=${created} cleared=${cleared}`);
	} finally {
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
	}
}
{
	// 回归（codex 评审）：判超时靠对 detail 做中文正则。插件自己产的中止原因（`超过 Xms`）
	// 反而匹配不上（真超时静默不给建议），job 取消的 'tool call aborted' 又会误命中（给出
	// 「调高 timeoutMs」的错误建议）。现在只认结构化标志，且区分「评审者超时 / job 硬上限 / 取消」。
	const hanging = {
		subagents: {
			getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } }),
			async startActivation(spec) {
				// 报错文案刻意不含「超时 / aborted / 中止」——真实服务侧的措辞不由插件决定，
				// 旧实现正是靠这些关键词猜超时，猜不中就静默。
				const result = new Promise((_, reject) => {
					const fail = () => reject(new Error(`子智能体已停止：${String(spec.signal?.reason)}`));
					// 信号可能在我们订阅之前就已经 abort 了（取消发生在子智能体起来之前）。
					if (spec.signal?.aborted === true) fail();
					else spec.signal?.addEventListener('abort', fail, { once: true });
				});
				return { childId: 'child-hanging', result, dispose: async () => {} };
			},
		},
	};
	const reviewerConfig = [{ id: 'deep', kind: 'subagent', provider: 'spawn', timeoutMs: 40 }];

	// 插件里的超时定时器是 `unref()` 的——真实运行时由子进程/网络 I/O 撑住事件循环，自测里
	// 必须自己撑住，否则 Node 会在定时器触发前判定「无事可做」，直接报未结算的顶层 await。
	const keepAlive = setInterval(() => {}, 10);
	try {
		const ownTimeout = await loadPlugin({ plugin: { reviewers: reviewerConfig }, harness: { ...GIT, services: hanging } });
		const ownValue = await run(ownTimeout, {});
		check('H 评审者超时：给出结构化建议', ownValue.report.includes('被该评审者的 `timeoutMs` 中止'), ownValue.report.slice(-600));

		const jobTimeout = await loadPlugin({ plugin: { hardTimeoutMs: 40, reviewers: [{ id: 'deep', kind: 'subagent', provider: 'spawn' }] }, harness: { ...GIT, services: hanging } });
		const jobValue = await run(jobTimeout, {});
		check('H job 硬上限：建议指向 hardTimeoutMs 而不是 timeoutMs', jobValue.report.includes('被本次评审的墙钟上限（`hardTimeoutMs`）中止'), jobValue.report.slice(-600));

		// 用户取消（job_kill / 工具调用被中断）：不是超时，不能给「调高超时」的建议。
		const killed = await loadPlugin({ plugin: { reviewers: [{ id: 'deep', kind: 'subagent', provider: 'spawn', timeoutMs: 60_000 }] }, harness: { ...GIT, services: hanging, wait: 'running' } });
		const running = await run(killed, {});
		killed.state.jobs.get(running.jobId).hooks.cancel('tool call aborted');
		const record = killed.state.jobs.get(running.jobId);
		await record.settledPromise;
		const killedText = record.chunks.map((chunk) => chunk.text).join('\n');
		check('H 用户取消不误报超时建议', !killedText.includes('timeoutMs') && !killedText.includes('hardTimeoutMs'), killedText.slice(0, 300));

		// 竞争（codex 验收）：用户先取消，但子智能体清理慢（60ms）而评审者上限只有 20ms——
		// 后到的定时器不能改写「已经发生的取消」，否则照样给出错误的调高超时建议。
		const slowCleanup = {
			subagents: {
				getProvider: () => ({ name: 'spawn', capabilities: { agentOptions: true, agentPreset: true } }),
				async startActivation(spec) {
					const result = new Promise((_, reject) => {
						const fail = () => setTimeout(() => reject(new Error(`子智能体已停止：${String(spec.signal?.reason)}`)), 60);
						if (spec.signal?.aborted === true) fail();
						else spec.signal?.addEventListener('abort', fail, { once: true });
					});
					return { childId: 'child-slow', result, dispose: async () => {} };
				},
			},
		};
		const raced = await loadPlugin({ plugin: { reviewers: [{ id: 'deep', kind: 'subagent', provider: 'spawn', timeoutMs: 20 }] }, harness: { ...GIT, services: slowCleanup, wait: 'running' } });
		const racedRunning = await run(raced, {});
		raced.state.jobs.get(racedRunning.jobId).hooks.cancel('tool call aborted');
		const racedRecord = raced.state.jobs.get(racedRunning.jobId);
		await racedRecord.settledPromise;
		const racedText = racedRecord.chunks.map((chunk) => chunk.text).join('\n');
		check('H 取消先发生时不改写中止原因', !racedText.includes('timeoutMs') && !racedText.includes('hardTimeoutMs'), racedText.slice(0, 400));

		// 反方向竞争（codex 验收指出未覆盖）：评审者自己的上限先到（20ms），job 硬上限随后
		// （40ms）才到——先到的原因同样不能被后来的入口改写。
		const reverse = await loadPlugin({
			plugin: { hardTimeoutMs: 40, reviewers: [{ id: 'deep', kind: 'subagent', provider: 'spawn', timeoutMs: 20 }] },
			harness: { ...GIT, services: slowCleanup },
		});
		const reverseValue = await run(reverse, {});
		check('H 评审者超时先发生时不被上游改写', reverseValue.report.includes('被该评审者的 `timeoutMs` 中止'), reverseValue.report.slice(-600));
	} finally {
		clearInterval(keepAlive);
	}
}
{
	// 回归（codex 评审）：stdout 被截断时（超过 collectMaxBytes，结论常常正好在尾部）脚注仍
	// 宣称「内容完整」，且 spillPath 被丢掉；capture: stdout 的预设（claude / gemini）连提示
	// 都没有。两条路都要把丢失信息带出来。
	const fallback = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: { ...GIT, stdout: '结论在 stdout 里', skipReportFile: true, stdoutLossy: true, stdoutSpillPath: '/tmp/spill-stdout.txt' },
	});
	const fallbackValue = await run(fallback, {});
	check('H stdout 回退被截断时写明截断', fallbackValue.report.includes('stdout 已被截断'), fallbackValue.report.slice(-500));
	check('H stdout 回退被截断时给出 spillPath', fallbackValue.report.includes('/tmp/spill-stdout.txt'), fallbackValue.report.slice(-500));
	check('H stdout 回退被截断时不再宣称内容完整', !fallbackValue.report.includes('内容完整'), fallbackValue.report.slice(-500));

	const captureStdout = await loadPlugin({
		plugin: { agents: [{ preset: 'claude' }] },
		harness: { ...GIT, stdout: 'claude 的结论', stdoutLossy: true, stdoutSpillPath: '/tmp/spill-claude.txt' },
	});
	const captureValue = await run(captureStdout, {});
	check('H capture: stdout 被截断也写明', captureValue.report.includes('stdout 已被截断') && captureValue.report.includes('/tmp/spill-claude.txt'), captureValue.report.slice(-500));

	const intact = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: { ...GIT, stdout: '结论在 stdout 里', skipReportFile: true },
	});
	const intactValue = await run(intact, {});
	check('H stdout 未被截断时明确说未截断', intactValue.report.includes('stdout 未被截断'), intactValue.report.slice(-500));
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
	const h = await loadPlugin({
		plugin: { agents: [{ preset: 'codex' }] },
		harness: { ...GIT, report: '结论' },
	});
	const value = await run(h, { commit: 'abc123' });
	const prompt = h.state.spawns.map((spec) => spec.stdio?.stdin?.data ?? '').join('\n');
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
	check('H 自定义 codex 形状：PROMPT 用 -- 终止符', focusArgv.at(-2) === '--' && focusArgv.at(-1).startsWith('只看并发'), JSON.stringify(focusArgv.slice(-2)));

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

/* ────────────────────────────── J. 浏览器半边（client bundle） ────────────────────────────── */

console.log('\nJ. 浏览器半边');

/**
 * 用桩件在 Node 里加载 client/client.js：真实格式是 window.__ModuleLoader__.load({id, factory})，
 * 工厂只要 react 与 primitives 两个 external，所以替身足够跑通 apply、纯逻辑与渲染树。
 */
async function loadClientBundle(options = {}) {
	const captured = { registrations: [], slots: [], locales: [], effects: [], disposers: [], models: [], injects: [], scope: undefined, entry: undefined, served: undefined };
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
		// 状态条只在 running 时开定时器；测试里不跑副作用，避免留下 interval。
		useEffect: () => {},
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
			/** 暂存草稿：field() 优先返回它，discard 与成功保存都会清掉（与官方一致）。 */
			this.stagedText = new Map();
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
			// 有草稿就返回草稿文本（官方模型如此），否则返回已落盘的值。
			if (this.stagedText.has(name)) {
				const staged = this.stagedText.get(name);
				return { text: staged ?? '', overridden: staged !== null, invalid: false };
			}
			const value = this.scope.getSnapshot().value ?? {};
			const read = (path) => path.split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), value);
			return { text: spec.format(read(name)), overridden: false, invalid: false };
		}
		actions() {
			return {
				edit: (field, text) => {
					this.dirty = true;
					this.stagedText.set(field, text);
					this.editLog.push([field, text]);
				},
				resetField: (field) => {
					this.dirty = true;
					this.stagedText.set(field, null); // null = 清除草稿（回落到 base）
					this.resetLog.push(field);
				},
				save: () => this.save(),
				discard: () => {
					this.discardCalls += 1;
					this.stagedText.clear();
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
			// 成功保存会清掉草稿（官方模型是 staged.clear()），失败则保留草稿供重试。
			this.stagedText.clear();
			this.dirty = false;
			this.failed = false;
		}
		dispose() {}
	}
	const primitives = { SettingsFormModel };
	// 这五个会渲染 children（表单容器、按钮、菜单锚点），其余是叶子控件。
	primitives.SettingsForm = (props) => ({ type: 'SettingsForm', props, children: asArray(props.children) });
	primitives.Button = (props) => ({ type: 'Button', props, children: asArray(props.children) });
	primitives.Menu = (props) => ({ type: 'Menu', props, children: [...asArray(props.anchor), ...asArray(props.children).filter((child) => child !== null && child !== undefined && child !== false)] });
	primitives.MenuGroup = (props) => ({ type: 'MenuGroup', props, children: asArray(props.children) });
	for (const name of ['SettingsValueField', 'Switch', 'Checkbox', 'SegmentedControl', 'Input']) primitives[name] = (props) => ({ type: name, props, children: [] });
	primitives.StateDot = (props) => ({ type: 'StateDot', props, children: [] });
	primitives.IconChevronDownOutlineRegular = (props) => ({ type: 'IconChevronDownOutlineRegular', props, children: [] });
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
				defaultReviewers: ['codex'],
				injectPolicy: true,
				language: 'zh',
				reviewers: [
					{ id: 'codex', kind: 'cli', preset: 'codex', executable: 'codex' },
					{ id: 'deep', kind: 'subagent', provider: 'spawn', agentProvider: 'bailian', agentModel: 'deepseek-v4.1-flash' },
				],
				modes: { deep: { strength: 'deep', reviewers: ['codex', 'deep'], when: 'complex' } },
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
	const remoteSession = { modelCatalog: async () => catalogResult };
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
		// deferRemote 模拟「插件 apply 时 remote.session 还没注册」：先存下依赖声明，
		// 等服务真的出现后由用例手动回调。
		get: options.deferRemote === true ? () => undefined : (service) => (service === 'remote.session' ? remoteSession : undefined),
		inject: (deps, callback) => {
			captured.injects.push(deps);
			const fire = (scope) => callback(scope);
			if (options.deferRemote === true) captured.remoteInject = fire;
			else fire({ get: (service) => (service === 'remote.session' ? remoteSession : undefined) });
			return () => {};
		},
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
	check('J cleanupModeBody 删掉空值', JSON.stringify(I.cleanupModeBody({ when: '', reviewers: [], strength: 'deep', minChangedLines: Number.NaN })) === JSON.stringify({ strength: 'deep' }));

	// ── 目录映射与选项推导 ──
	const groups = I.catalogGroups({ groups: [{ id: 'bailian', name: '百炼', models: [{ id: 'qwen3.8-max' }] }, { nonsense: true }, { id: 'x', models: [null, { id: 'ok' }] }] });
	check('J catalogGroups 过滤坏形状', groups.length === 2 && groups[0].name === '百炼' && groups[1].models.length === 1, JSON.stringify(groups.map((g) => g.id)));
	check('J catalogGroups 对空目录返回空', I.catalogGroups(undefined).length === 0 && I.catalogGroups({ groups: 'nope' }).length === 0);
	// 合并选择器：目录摊平成 provider/model 路由，选中时一次写回两个字段。
	const routes = I.modelRoutes(groups);
	check('J modelRoutes 摊平 provider 与模型', routes.length === 2 && routes[0].provider === 'bailian' && routes[0].modelName === 'qwen3.8-max' && routes[1].provider === 'x', JSON.stringify(routes.map((route) => `${route.provider}/${route.model}`)));
	check('J findModelRoute 精确匹配', I.findModelRoute(groups, 'bailian', 'qwen3.8-max')?.providerName === '百炼' && I.findModelRoute(groups, 'bailian', 'nope') === undefined);
	const kept = I.currentModelRoute(groups, 'gone', 'old-model');
	check('J 目录外的当前值不丢', kept?.missing === true && kept.provider === 'gone' && kept.model === 'old-model', JSON.stringify(kept));
	check('J 未配置模型时不伪造当前值', I.currentModelRoute(groups, undefined, '') === undefined);
	check('J 目录里的当前值带展示名', I.currentModelRoute(groups, 'bailian', 'qwen3.8-max')?.modelName === 'qwen3.8-max');
	check('J presetExecutable 把 cursor 映射到 cursor-agent', I.presetExecutable('cursor') === 'cursor-agent' && I.presetExecutable('codex') === 'codex');
	const withCatalog = I.newReviewerRow(3, groups);
	// 有模型目录时给子智能体（现在只剩这一种「用 DSH 里配好的模型」的方式）。
	check('J 新行优先给子智能体', withCatalog.kind === 'subagent' && withCatalog.provider === 'spawn' && withCatalog.agentProvider === 'bailian' && withCatalog.agentModel === 'qwen3.8-max' && withCatalog.id === 'reviewer-3', JSON.stringify(withCatalog));
	const withoutCatalog = I.newReviewerRow(1, []);
	check('J 没有目录时新行给 codex CLI', withoutCatalog.kind === 'cli' && withoutCatalog.preset === 'codex' && withoutCatalog.executable === 'codex', JSON.stringify(withoutCatalog));

	// ── 字段清单：每个字段都有控件与分组 ──
	const paths = I.FIELDS.map((field) => field.path);
	check('J 字段数量', I.FIELDS.length === 13, String(I.FIELDS.length));
	check('J 字段路径唯一', new Set(paths).size === paths.length);
	// 结构：defaultReviewers 归顶部列表，reviewers 常显，其余都在 advanced 的子分组里
	const bySection = (section) => I.FIELDS.filter((field) => field.section === section).map((field) => field.path).sort().join(',');
	check('J 顶部列表只管 defaultReviewers', bySection('active') === 'defaultReviewers', bySection('active'));
	check('J 评审者定义常显', bySection('reviewers') === 'reviewers', bySection('reviewers'));
	check('J 其余字段都在高级配置里', I.FIELDS.filter((field) => field.section === 'advanced').length === 11, String(I.FIELDS.filter((field) => field.section === 'advanced').length));
	check('J 高级子分组都非空', I.ADVANCED_GROUPS.every((group) => I.FIELDS.some((field) => field.section === 'advanced' && field.group === group.key)), JSON.stringify(I.ADVANCED_GROUPS));
	const switchFields = I.FIELDS.filter((field) => field.control === 'switch').length;
	const textFields = I.FIELDS.filter((field) => field.control === 'text' || field.control === 'number').length;
	check('J 布尔字段用 Switch', switchFields === 1, String(switchFields));
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
		check('J 字典键数量合理', zhKeys.length >= 80, String(zhKeys.length));
		// 每个键都要被用到（t('key')、三元里的键、以及 FIELDS 里的 label/hint）
		const source = readFileSync(new URL('./client/client.js', import.meta.url), 'utf8');
		const used = new Set([...source.matchAll(/(?<![A-Za-z0-9_$])t\('([A-Za-z0-9._-]+)'\)/g)].map((match) => match[1]));
		for (const match of source.matchAll(/\?\s*'([A-Za-z0-9]+)'\s*:\s*'([A-Za-z0-9]+)'/g)) {
			used.add(match[1]);
			used.add(match[2]);
		}
		for (const match of source.matchAll(/(?:label|hint|invalid):\s*'([A-Za-z0-9]+)'/g)) used.add(match[1]);
		const unused = zhKeys.filter((key) => !used.has(key));
		check('J 没有没人用的文案键', unused.length === 0, unused.join(','));
		// 反过来也要查：用到的键必须两种语言都有（之前 catalogLoading 就是被删了但还在用，
		// 界面上会显示成键名——只查「有没有人用」抓不到这种）。
		// 只看真正的字典查找 `t('key')`：三元里的字符串常量不一定是文案键。
		const tKeys = new Set([...source.matchAll(/(?<![A-Za-z0-9_$])t\('([A-Za-z0-9._-]+)'\)/g)].map((match) => match[1]));
		const missing = [...tKeys].filter((key) => !zhKeys.includes(key));
		check('J 用到的文案键都存在', missing.length === 0, missing.join(','));
	}

	check('J 读取 review 命名空间', captured.entry === 'review', captured.entry);
	check('J 只在宿主 serve 命名空间时挂载', JSON.stringify(captured.served) === JSON.stringify(['review']), JSON.stringify(captured.served));
	check('J 行页、包页与状态条三个槽位都占', JSON.stringify(captured.slots) === JSON.stringify(['plugins.row.config', 'plugins.bundle.config', 'conversation.input.dock']), JSON.stringify(captured.slots));
	check('J 槽位 key 正确', JSON.stringify(captured.registrations.map((entry) => entry.options.key)) === JSON.stringify(['dsh-review#review', 'dsh-review', undefined]), JSON.stringify(captured.registrations.map((entry) => entry.options.key)));
	const face = captured.registrations[0].options.inject();
	check('J inject 提供表单 hook、目录 hook 与写动作', Boolean(face.hooks?.reviewConfigForm) && Boolean(face.hooks?.reviewCatalog) && typeof face.save === 'function' && typeof face.edit === 'function' && typeof face.resetField === 'function', Object.keys(face).join(','));
	check('J 布尔 spec 认是/否', JSON.stringify(spec('injectPolicy').parse('是')) === JSON.stringify({ kind: 'set', value: true }) && JSON.stringify(spec('injectPolicy').parse('off')) === JSON.stringify({ kind: 'set', value: false }));
	check('J 布尔 spec 拒绝乱填', spec('injectPolicy').parse('maybe') === undefined);
	check('J 列表 spec 空值 = 清除', JSON.stringify(spec('reviewers').parse('  ')) === JSON.stringify({ kind: 'clear' }));
	check('J 数字 spec 拒绝负数与小数', spec('maxArgBytes').parse('-1') === undefined && spec('waitMs').parse('1.5') === undefined && spec('waitMs').parse('60000')?.value === 60000);
	check('J reviewers spec 接受合法数组', Array.isArray(spec('reviewers').parse('[{"id":"a","kind":"subagent"}]')?.value));
	check('J reviewers spec 拒绝缺 id', spec('reviewers').parse('[{"kind":"cli"}]') === undefined);
	// kind 不在表单侧卡死（老配置的 llm 行要让整表仍可保存，宿主会告警并忽略它）。
	check('J reviewers spec 原样带过已移除的 kind', spec('reviewers').parse('[{"id":"a","kind":"llm"}]')?.value?.[0]?.kind === 'llm');
	check('J reviewers spec 也带过乱码 kind', spec('reviewers').parse('[{"id":"a","kind":"nope"}]')?.value?.[0]?.id === 'a');
	// 行内要提示这个类型已移除，而不是静默当作子智能体
	const legacy = { shell: { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }, fields: {} };
	check('J 已移除的类型有说明文案', Object.hasOwn(captured.locales[0].dictionaries.zh, 'reviewerKindRemoved') && Object.hasOwn(captured.locales[0].dictionaries.en, 'reviewerKindRemoved'));
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
	check('J 顶部列出 id 与指向', findAll(element, (node) => node.props?.className === 'dsh-review-active-id').map((node) => node.props.children).join(',') === 'codex,deep', JSON.stringify(findAll(element, (node) => node.props?.className === 'dsh-review-active-id').map((node) => node.props.children)));
	check('J 顶部显示指向的可执行名/模型路由', findAll(element, (node) => node.props?.className === 'dsh-review-active-meta').map((node) => node.props.children).join(' | ') === 'cli · codex | subagent · bailian/deepseek-v4.1-flash', JSON.stringify(findAll(element, (node) => node.props?.className === 'dsh-review-active-meta').map((node) => node.props.children)));
	// defaultReviewers 是 ['codex']，所以只有 codex 那行是勾着的。
	const activeItems = findAll(element, (node) => node.props?.className === 'dsh-review-active-item');
	check('J 顶部开关反映勾选状态', activeItems.length === 2 && activeItems[0].props.children[0].props.checked === true && activeItems[1].props.children[0].props.checked === false, JSON.stringify(activeItems.map((item) => item.props.children[0].props.checked)));
	// 子智能体的 provider/模型合成一个按 provider 分组的选择器：当前值不在目录里时
	// 先给一条「当前配置」，再是两个 provider 分组、三个模型。
	const modelGroups = findAll(element, (node) => node.type === 'MenuGroup');
	check('J 模型选择器按 provider 分组', modelGroups.length === 3 && modelGroups[0].props.label === 'modelNotInCatalog' && modelGroups[1].props.label === '百炼' && modelGroups[2].props.label === 'DeepSeek', JSON.stringify(modelGroups.map((group) => group.props.label)));
	const modelOptions = findAll(element, (node) => node.props?.role === 'menuitemradio');
	check('J 合并选择器列出目录里的模型', modelOptions.length === 4, String(modelOptions.length));
	check('J 触发器同时显示模型与 provider', findAll(element, (node) => node.props?.className === 'dsh-review-model-trigger-provider').map((node) => node.props.children).join(',') === '百炼', JSON.stringify(findAll(element, (node) => node.props?.className === 'dsh-review-model-trigger-provider').map((node) => node.props.children)));
	check('J 不再单独渲染 agentProvider 下拉', findAll(element, (node) => node.props?.id === 'reviewer-1-agent-provider').length === 0);
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
	check('J 展开后开关数量（字段 1 + 顶部 2 + 行内 2）', switches.length === 1 + 2 + 2, String(switches.length));
	const switchHolder = findAll(element, (node) => node.props?.className === 'dsh-review-field').find((node) => findAll(node, (child) => child.props?.children === 'injectPolicy').length > 0);
	check('J 高级里的开关反映取值', findAll(switchHolder, (node) => node.type === 'Switch')[0]?.props?.checked === true, JSON.stringify(findAll(switchHolder, (node) => node.type === 'Switch').map((n) => n.props.checked)));
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
	check('J 目录失败时提示可见', findAll(element, (node) => node.props?.children === 'catalogFailed').length >= 1);
	check('J 目录失败时仍渲染表单', element?.type !== undefined && findAll(element, (node) => node.type === 'Input').length > 0);
	// 合并选择器在目录不可用时退回两个输入框，当前值仍然可编辑。
	check('J 目录失败时模型选择退回手填', findAll(element, (node) => node.props?.className === 'dsh-review-model-fallback').length === 1);
}

{
	// 回归：刚装插件时 remote.session 还没注册。以前 apply 时取一次就永远不再试，
	// provider 下拉一直空着，必须关开插件才恢复。现在声明依赖，服务晚到也会补加载。
	const { mod, ctx, captured } = await loadClientBundle({ deferRemote: true });
	mod.apply(ctx);
	const face = captured.registrations[0].options.inject();
	const idleSnapshot = face.hooks.reviewCatalog.getSnapshot();
	check('J 目录服务没就绪时保持 idle', idleSnapshot.status === 'idle', idleSnapshot.status);
	check('J 声明了 remote.session 依赖', captured.injects.some((deps) => Array.isArray(deps) && deps.includes('remote.session')), JSON.stringify(captured.injects));
	check('J 依赖就绪前不伪造空目录', face.hooks.reviewCatalog.getSnapshot().groups.length === 0);
	check('J 保存了服务就绪后的回调', typeof captured.remoteInject === 'function');
	captured.remoteInject({
		get: (service) =>
			service === 'remote.session'
				? { modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'bailian', name: '百炼', models: [{ id: 'qwen3.8-max' }] }] } }) }
				: undefined,
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	check('J 服务晚到时自动补加载目录', face.hooks.reviewCatalog.getSnapshot().status === 'ready' && face.hooks.reviewCatalog.getSnapshot().groups.length === 1, JSON.stringify(face.hooks.reviewCatalog.getSnapshot()));
	check('J 目录更新换了新快照对象', face.hooks.reviewCatalog.getSnapshot() !== idleSnapshot, 'same object');
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
	const replayed = model.editLog.map(([field, text]) => `${field}=${text}`);
	check('J2 冲突恢复只重放动过的字段', [...new Set(model.editLog.map(([field]) => field))].join(',') === 'language', JSON.stringify(model.editLog));
	// 关键：重放的必须是用户敲进去的值（'en'），不是取回草稿后读到的旧值（假宿主里是 'zh'）
	check('J2 冲突恢复重放的是用户的编辑值', replayed.every((entry) => entry === 'language=en'), JSON.stringify(replayed));
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
		const config = { agents: [{ preset: 'codex' }], modes: { deep: { strength: 'deep' } }, waitMs: 60000, 未知键: '保留' };
		const resolved = Config(config);
		check('K schema 接受部分配置（缺省字段不报错）', resolved !== undefined);
		check('K 未声明的键不被丢弃', schema.unwrapConfig(resolved).未知键 === '保留' && Array.isArray(schema.unwrapConfig(resolved).agents), JSON.stringify(Object.keys(schema.unwrapConfig(resolved))));
		check('K 声明的字段是 volatile 盒子', schema.isVolatileBox(resolved.waitMs) === true, typeof resolved.waitMs);
		check('K 盒子取回原始值', resolved.waitMs.get() === 60000);
		check('K reviewers/modes 原样透传', JSON.stringify(schema.unwrapConfig(resolved).modes) === JSON.stringify({ deep: { strength: 'deep' } }));
		// 最关键的一条：声明 schema 之后，配置归一化的结果与不声明时完全一致。
		const viaSchema = resolveSettings(schema.unwrapConfig(resolved));
		const direct = resolveSettings(config);
		check('K schema 不改变归一化结果', JSON.stringify({ ...viaSchema, warnings: [] }) === JSON.stringify({ ...direct, warnings: [] }), JSON.stringify(viaSchema.reviewers.length) + ' vs ' + JSON.stringify(direct.reviewers.length));
		// GUI 写入的值同样走这条路
		// GUI 写入的值同样走这条路；被选中的 id 必须真的存在（关掉 adHoc 时未知 id 会被过滤并告警）。
		const edited = resolveSettings(schema.unwrapConfig(Config({ agents: [{ preset: 'codex' }], defaultReviewers: ['codex'], discover: { adHoc: false } })));
		check('K GUI 写入后归一化生效', edited.defaultReviewers.join(',') === 'codex', JSON.stringify(edited.defaultReviewers));

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
		};
		const drifted = Object.entries(shared).filter(([path, expected]) => {
			const actual = meta(path.split('.')).default;
			return JSON.stringify(actual) !== JSON.stringify(expected);
		});
		check('K schema 默认值与插件 DEFAULTS 一致', drifted.length === 0, JSON.stringify(drifted.map(([path, expected]) => `${path}: schema=${JSON.stringify(meta(path.split('.')).default)} defaults=${JSON.stringify(expected)}`)));
		// 表单打开时数值/开关字段应该有真实值可显示
		check('K 数值与开关默认值可显示', meta(['waitMs']).default === 0 && meta(['injectPolicy']).default === false && meta(['language']).default === 'auto');
		check('K 硬超时默认 0（不限制）', meta(['hardTimeoutMs']).default === 0);
	}
}

/* ────────────────────────────── L. schema 解析 ────────────────────────────── */

console.log('\nL. schema 解析');
{
	// 回归：全局安装的 `dsh` 是指向安装目录的符号链接。旧实现只取 dirname(argv[1])，
	// 落在 `.bin` 里找不到宿主依赖，Config 直接变 undefined，GUI 配置页随之消失。
	const { schemaSource } = await import(new URL('./lib/schema.js', import.meta.url).href);
	if (typeof schemaSource !== 'string') {
		check('L 本机 schemastery 可解析', false, '本机也找不到 schemastery，跳过符号链接回归');
	} else {
		const root = mkdtempSync(join(tmpdir(), 'dsh-review-schema-'));
		try {
			const packageRoot = dirname(dirname(schemaSource));
			const hostLib = join(root, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib');
			mkdirSync(hostLib, { recursive: true });
			writeFileSync(join(hostLib, 'bin.js'), '');
			symlinkSync(packageRoot, join(root, 'host', 'node_modules', '@deepseek-ai', 'schemastery'), 'dir');
			mkdirSync(join(root, 'bin'), { recursive: true });
			const link = join(root, 'bin', 'dsh');
			symlinkSync(join(hostLib, 'bin.js'), link);
			mkdirSync(join(root, 'home'), { recursive: true });
			mkdirSync(join(root, 'cwd'), { recursive: true });
			const script = [
				`process.argv[1] = ${JSON.stringify(link)};`,
				`process.env.DSH_HOME = ${JSON.stringify(join(root, 'home'))};`,
				`process.chdir(${JSON.stringify(join(root, 'cwd'))});`,
				`const m = await import(${JSON.stringify(new URL('./lib/schema.js', import.meta.url).href)});`,
				`process.stdout.write(m.schemaAvailable ? 'yes' : 'no');`,
			].join('\n');
			const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
			check('L 符号链接的 dsh bin 也能找到 schemastery', result.status === 0 && result.stdout === 'yes', `${result.status} ${result.stdout} ${result.stderr}`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
}


/* ────────────────────────────── M. 评审状态投影 ────────────────────────────── */

console.log('\nM. 评审状态投影');
{
	const statusMod = await import(new URL('./lib/status.js', import.meta.url).href);
	const { applyReviewStatus, createReviewStatusProjection, createReviewStatusState, normalizeReviewStatusState, parseReviewLabel, reviewStatusProjection, reviewStatusView } = statusMod;

	const parsedUncommitted = parseReviewLabel('review(codex,deep) --uncommitted');
	check('M 解析未提交范围的评审者', JSON.stringify(parsedUncommitted.reviewers) === JSON.stringify(['codex', 'deep']) && parsedUncommitted.scope === 'uncommitted', JSON.stringify(parsedUncommitted));
	const parsedBase = parseReviewLabel('review(deep-dive) --base main +instructions「只看并发」');
	check('M 解析相对分支范围', parsedBase.scope === 'base' && parsedBase.scopeRef === 'main' && parsedBase.reviewers[0] === 'deep-dive', JSON.stringify(parsedBase));
	const parsedCommit = parseReviewLabel('review(codex) --commit abc1234');
	check('M 解析提交范围', parsedCommit.scope === 'commit' && parsedCommit.scopeRef === 'abc1234', JSON.stringify(parsedCommit));
	const parsedBad = parseReviewLabel('not-a-review-label');
	check('M 认不出的 label 降级为未知范围', parsedBad.scope === 'unknown' && parsedBad.reviewers.length === 0, JSON.stringify(parsedBad));

	const now = Date.now();
	const event = (type, data, time = now) => ({ type, time, data });
	let state = createReviewStatusState();
	check('M 空状态', state.rounds === 0 && state.running === 0 && state.runs.length === 0 && state.reviewers.length === 0);

	state = applyReviewStatus(state, event('job/registered', { jobId: 'job-1', kind: 'review', label: 'review(codex,deep) --uncommitted', startedAt: now }));
	let view = reviewStatusView(state);
	check('M 注册一轮 → 轮数与运行数', view.rounds === 1 && view.running === 1 && view.runs.length === 1, JSON.stringify(view));
	check('M 注册一轮 → 评审者从 label 解析', JSON.stringify(view.reviewers) === JSON.stringify(['codex', 'deep']), JSON.stringify(view.reviewers));
	check('M wire 不暴露 active', !Object.hasOwn(reviewStatusProjection.wire.view(state), 'active'));

	const unrelated = state;
	state = applyReviewStatus(state, event('assistant/message', { turn: 1 }));
	check('M 无关事件返回同一个状态引用', state === unrelated);

	state = applyReviewStatus(state, event('job/settled', { jobId: 'job-1', kind: 'review', status: 'completed', detail: '2/2 个评审者完成', startedAt: now, finishedAt: now + 5_000 }, now + 5_000));
	view = reviewStatusView(state);
	check('M 结算 → 运行数归零、状态回填', view.running === 0 && view.runs[0].status === 'completed' && view.runs[0].detail === '2/2 个评审者完成', JSON.stringify(view.runs[0]));

	state = applyReviewStatus(state, event('job/registered', { jobId: 'job-2', kind: 'review', label: 'review(deep-dive) --base main', startedAt: now + 6_000 }, now + 6_000));
	state = applyReviewStatus(state, event('job/settled', { jobId: 'job-2', kind: 'review', status: 'failed', startedAt: now + 6_000, finishedAt: now + 7_000 }, now + 7_000));
	view = reviewStatusView(state);
	check('M 两轮后轮数与评审者并集', view.rounds === 2 && JSON.stringify(view.reviewers) === JSON.stringify(['codex', 'deep', 'deep-dive']), JSON.stringify(view));
	check('M 失败轮次保留原因', view.runs[1].status === 'failed', JSON.stringify(view.runs[1]));

	// workspace-changes：只记录事件/轮次，客户端据此判断「这一轮有没有改动」。
	state = applyReviewStatus(state, event('turn/start', { turn: 1 }));
	state = applyReviewStatus(state, event('workspace/changes', { turn: 1 }));
	state = applyReviewStatus(state, event('turn/end', { turn: 1 }));
	view = reviewStatusView(state);
	check('M 折入 turn 与改动轮次', view.changes.enabled === true && view.changes.currentTurn === 1 && view.changes.inTurn === false && view.changes.changesTurn === 1, JSON.stringify(view.changes));
	state = applyReviewStatus(state, event('turn/start', { turn: 2 }));
	check('M 新一轮进行中', reviewStatusView(state).changes.inTurn === true);
	state = applyReviewStatus(state, event('turn/end', { turn: 2 }));
	const noChangeView = reviewStatusView(state);
	check('M 无改动轮次不推进改动轮次', noChangeView.changes.currentTurn === 2 && noChangeView.changes.changesTurn === 1, JSON.stringify(noChangeView.changes));
	const noTrack = createReviewStatusProjection({ trackWorkspaceChanges: false });
	check('M 没有 workspaceChanges 能力时标记关闭', noTrack.init().changesEnabled === false);
	// projection 的 state 会被 structuredClone 后按「无损 JSON」校验；任何 undefined / NaN
	// 都会让 checkpoint 写入直接失败，所以这里把整份状态扫一遍。
	const badJson = (value, path = 'state') => {
		if (value === undefined) return path;
		if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return path;
		if (value === null || typeof value !== 'object') return '';
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index += 1) {
				const found = badJson(value[index], `${path}[${index}]`);
				if (found.length > 0) return found;
			}
			return '';
		}
		for (const [key, child] of Object.entries(value)) {
			const found = badJson(child, `${path}.${key}`);
			if (found.length > 0) return found;
		}
		return '';
	};
	const detached = structuredClone(state);
	check('M 状态是无损 JSON（可写入 projection cache）', badJson(detached) === '', badJson(detached));
	check('M fold 保留 bootId', state.bootId === createReviewStatusState().bootId, String(state.bootId));

	// 上一进程遗留的 running：视图改判 interrupted，且不显示「还在跑」。
	const stale = {
		...createReviewStatusState(),
		rounds: 1,
		running: 1,
		runs: [{ id: 'old', round: 1, label: 'review(codex) --uncommitted', reviewers: ['codex'], scope: 'uncommitted', scopeRef: '', startedAt: 1_000, finishedAt: undefined, status: 'running', detail: undefined }],
		reviewers: ['codex'],
		active: { old: true },
	};
	const staleView = reviewStatusView(stale);
	check('M 旧进程遗留 running 改判中断', staleView.running === 0 && staleView.runs[0].status === 'interrupted', JSON.stringify(staleView));
	const oldCompleted = { ...stale, running: 0, runs: [{ ...stale.runs[0], status: 'completed', finishedAt: 2_000 }], active: {} };
	check('M 旧进程已完成的轮次不被改判', reviewStatusView(oldCompleted).runs[0].status === 'completed');

	const cached = { ...stale, bootId: 'previous-process' };
	const normalized = normalizeReviewStatusState(cached);
	check('M 旧 bootId 的缓存清掉运行态', normalized.running === 0 && normalized.runs[0].status === 'interrupted' && normalized.active.old === undefined, JSON.stringify(normalized));
	// 同进程恢复 + 超过 30 个并发评审：最早的仍在 running，不能被裁剪掉。
	const many = createReviewStatusState();
	many.runs = Array.from({ length: 31 }, (_, index) => ({
		id: `job-${index}`,
		round: index + 1,
		label: 'review(codex) --uncommitted',
		reviewers: ['codex'],
		scope: 'uncommitted',
		scopeRef: '',
		startedAt: now + index,
		status: index === 0 ? 'running' : 'completed',
	}));
	many.running = 1;
	many.active = { 'job-0': true };
	many.reviewers = ['codex'];
	many.rounds = 31;
	const manyNormalized = normalizeReviewStatusState(many);
	check('M 超 30 并发时保留 running', manyNormalized.runs.some((run) => run.id === 'job-0' && run.status === 'running') && reviewStatusView(manyNormalized).running === 1, JSON.stringify(manyNormalized.runs.map((run) => `${run.id}:${run.status}`)));
	const parsedCache = reviewStatusProjection.stateSchema.parse(cached);
	check('M stateSchema 回读同样清运行态', parsedCache.running === 0 && parsedCache.runs[0].status === 'interrupted');
	// 缓存落后于日志：checkpoint 停在 running，settlement 已写进日志；重放必须能回填。
	const replayed = applyReviewStatus(parsedCache, event('job/settled', { jobId: 'old', kind: 'review', status: 'completed', detail: '1/1 个评审者完成', finishedAt: 2_000 }, 2_000));
	const replayedView = reviewStatusView(replayed);
	check('M 缓存恢复后的 settlement 能回填', replayedView.runs[0].status === 'completed' && replayedView.running === 0 && replayed.active.old === undefined, JSON.stringify(replayedView.runs[0]));

	// runs 有上限，rounds 不受影响。
	let capped = createReviewStatusState();
	for (let index = 0; index < 35; index += 1) {
		const startedAt = now + index * 10;
		capped = applyReviewStatus(capped, event('job/registered', { jobId: `job-${index}`, kind: 'review', label: 'review(codex) --uncommitted', startedAt }, startedAt));
		capped = applyReviewStatus(capped, event('job/settled', { jobId: `job-${index}`, kind: 'review', status: 'completed', startedAt, finishedAt: startedAt + 5 }, startedAt + 5));
	}
	const cappedView = reviewStatusView(capped);
	check('M 35 轮后 rounds 仍为 35', cappedView.rounds === 35, String(cappedView.rounds));
	check('M runs 只保留最近 30 轮', cappedView.runs.length === 30, String(cappedView.runs.length));
	check('M 保留的是最近的轮次', cappedView.runs[cappedView.runs.length - 1].round === 35, String(cappedView.runs[cappedView.runs.length - 1].round));

	// 宿主 apply 真的把投影注册到 sessionProjections（不是只导出定义）。
	const registered = [];
	await loadPlugin({ services: { sessionProjections: { register(definition) { registered.push(definition); return () => {}; } } } });
	check('M 插件注册状态投影', registered.length === 1 && registered[0].key === 'dsh-review/status' && typeof registered[0].wire?.view === 'function', JSON.stringify(registered.map((definition) => definition.key)));
	const registeredWithChanges = [];
	await loadPlugin({ services: { sessionProjections: { register(definition) { registeredWithChanges.push(definition); return () => {}; } }, workspaceChanges: { summary: () => undefined, diff: async () => undefined } } });
	check('M 有 workspaceChanges 时开启改动检测', registeredWithChanges.length === 1 && registeredWithChanges[0].init().changesEnabled === true);
	await loadPlugin({ services: { sessionProjections: { register(definition) { registered.push(definition); return () => {}; } } } });
	check('M 没有 workspaceChanges 时关闭改动检测', registered[registered.length - 1].init().changesEnabled === false);
}

/* ────────────────────────────── N. 评审状态条 ────────────────────────────── */

console.log('\nN. 评审状态条');
{
	const bundle = await loadClientBundle();
	bundle.mod.apply(bundle.ctx);
	const { mod, captured } = bundle;
	const I = mod.__internals;
	const t = (key) => captured.locales[0].dictionaries.zh[key] ?? key;

	check('N 状态条 key 与宿主一致', I.REVIEW_STATUS_KEY === 'dsh-review/status');
	check('N 已注册状态条槽位', captured.slots.includes('conversation.input.dock'));

	const idle = I.reviewStatusSummary({ rounds: 0, running: 0, runs: [], reviewers: [] }, Date.now(), t);
	check('N 未评审状态的文案', idle.state === 'idle' && idle.text === '尚未评审', JSON.stringify(idle));
	const progress = I.reviewStatusSummary(
		{
			rounds: 2,
			running: 1,
			runs: [
				{ id: 'job-1', round: 1, reviewers: ['codex'], scope: 'uncommitted', scopeRef: '', startedAt: Date.now() - 120_000, status: 'completed', detail: '1/1 个评审者完成' },
				{ id: 'job-2', round: 2, reviewers: ['codex', 'deep-dive'], scope: 'base', scopeRef: 'main', startedAt: Date.now() - 65_000, status: 'running' },
			],
			reviewers: ['codex', 'deep-dive'],
		},
		Date.now(),
		t,
	);
	check('N 进行中状态与用时', progress.state === 'running' && progress.text.includes('第 2 轮评审中') && progress.text.includes('相对 main') && progress.meta.includes('1 分'), JSON.stringify(progress));
	const failed = I.reviewStatusSummary(
		{ rounds: 2, running: 0, runs: [{ id: 'job-2', round: 2, reviewers: ['codex'], scope: 'base', scopeRef: 'main', startedAt: Date.now() - 5_000, status: 'failed' }], reviewers: ['codex'] },
		Date.now(),
		t,
	);
	check('N 最近一轮失败', failed.state === 'failed' && failed.text === '第 2 轮失败 · 相对 main', JSON.stringify(failed));
	check('N 时长格式', I.formatReviewDuration(65_000, t) === '1 分 05 秒' && I.formatReviewDuration(9_000, t) === '9 秒', I.formatReviewDuration(65_000, t));

	const chips = I.reviewReviewerChips(['codex', 'deep-dive', 'claude', 'gemini'], t);
	check('N 评审者胶囊最多 2 个', chips.shown.length === 2 && chips.more === '+2' && chips.title.includes('gemini'), JSON.stringify(chips));

	const session = { blank: false, pendingSubmissions: [], running: false };
	const status = {
		rounds: 2,
		running: 0,
		reviewers: ['codex', 'deep-dive'],
		runs: [
			{ id: 'job-1', round: 1, reviewers: ['codex'], scope: 'uncommitted', scopeRef: '', startedAt: Date.now() - 120_000, finishedAt: Date.now() - 60_000, status: 'completed', detail: '1/1 个评审者完成' },
			{ id: 'job-2', round: 2, reviewers: ['deep-dive'], scope: 'base', scopeRef: 'main', startedAt: Date.now() - 5_000, finishedAt: Date.now() - 1_000, status: 'failed', detail: '0/1 个评审者完成' },
		],
	};
	const rendered = renderTree(I.ReviewStatusDock({ session, useProjection: () => status, t }));
	const details = rendered.find((node) => node.props?.className === 'dsh-review-status');
	check('N 渲染 details 状态', details?.props?.['data-state'] === 'failed', JSON.stringify(details?.props?.['data-state']));
	check('N 状态条文案', rendered.some((node) => node.props?.className === 'dsh-review-status-text' && node.props?.children === '第 2 轮失败 · 相对 main'));
	check('N 评审者胶囊', rendered.filter((node) => node.props?.className === 'dsh-review-status-reviewer').length === 2);
	check('N 简单状态点使用 warning', rendered.some((node) => node.type === 'StateDot' && node.props?.state === 'warning'));
	check('N 展开面板含两轮历史', rendered.filter((node) => node.props?.className === 'dsh-review-status-run').length === 2);
	check('N 面板按最近一轮在前', rendered.find((node) => node.props?.className === 'dsh-review-status-run-round')?.props?.children === '#2');
	check('N 面板范围文案', rendered.some((node) => typeof node.props?.children === 'string' && node.props.children.includes('相对 main')));

	const idleRendered = renderTree(I.ReviewStatusDock({ session, useProjection: () => ({ rounds: 0, running: 0, runs: [], reviewers: [] }), t }));
	check('N 未评审时显示空面板提示', idleRendered.some((node) => node.props?.className === 'dsh-review-status-empty' && typeof node.props?.children === 'string' && node.props.children.includes('还没有评审记录')));
	check('N projection 缺失时静默', I.ReviewStatusDock({ session, useProjection: () => undefined, t }) === null);

	// 空对话 / 本轮无改动时的隐藏规则。
	const emptySession = { blank: true, pendingSubmissions: [], running: false };
	check('N 空对话隐藏', I.reviewStatusVisible(emptySession, status) === false);
	check('N 首条消息待发时显示', I.reviewStatusVisible({ ...emptySession, pendingSubmissions: [{}] }, status) === true);
	check('N 已尝试发送但队列为空时仍显示', I.reviewStatusVisible({ ...emptySession, promptAttempted: true }, status) === true);
	check('N 空对话但在跑时显示', I.reviewStatusVisible({ ...emptySession, running: true }, status) === true);
	check('N 空对话不渲染', I.ReviewStatusDock({ session: emptySession, useProjection: () => status, t }) === null);

	const noChanges = { ...status, running: 0, changes: { enabled: true, currentTurn: 3, inTurn: false, changesTurn: 2 } };
	check('N 本轮无改动隐藏', I.reviewStatusVisible(session, noChanges) === false);
	check('N 本轮无改动不渲染', I.ReviewStatusDock({ session, useProjection: () => noChanges, t }) === null);
	check('N 本轮有改动显示', I.reviewStatusVisible(session, { ...noChanges, changes: { ...noChanges.changes, changesTurn: 3 } }) === true);
	check('N 轮次进行中显示', I.reviewStatusVisible(session, { ...noChanges, changes: { ...noChanges.changes, inTurn: true } }) === true);
	check('N 评审运行中覆盖无改动', I.reviewStatusVisible(session, { ...noChanges, running: 1 }) === true);
	check('N 会话运行中覆盖无改动', I.reviewStatusVisible({ ...session, running: true }, noChanges) === true);
	check('N 子智能体会话不按改动隐藏', I.reviewStatusVisible({ ...session, subagent: { address: { kind: 'subagent' } } }, noChanges) === true);
	check('N 没有改动能力时不按改动隐藏', I.reviewStatusVisible(session, { ...noChanges, changes: { ...noChanges.changes, enabled: false } }) === true);
	check('N 还没有 turn 时显示', I.reviewStatusVisible(session, { ...noChanges, changes: { enabled: true, currentTurn: 0, inTurn: false, changesTurn: 0 } }) === true);
}

console.log(`\n${passes} 项通过，${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);