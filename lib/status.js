/**
 * 会话级「评审状态」投影：把 `job/registered` / `job/settled` 里的 review 任务折成一份
 * 客户端可读的整值快照，供对话与输入框之间的状态条渲染。
 *
 * 为什么用 session projection 而不是客户端直接读 jobs 列表：
 *
 * - jobs 注册表是**进程内**的；宿主重启或重新打开会话后，已经结束的评审就不在列表里了。
 *   projection 的 state 会随会话日志一起持久化（checkpoint），重开会话仍能数出「几轮」。
 * - projection 的 drive 是纯同步 fold：注册、结束各一次事件更新，客户端拿到的是一份
 *   完整快照，不需要在浏览器里拼 job 生命周期。
 *
 * 只依赖 job 事件里的公开字段（kind / label / jobId / startedAt / status / detail），
 * 不碰评审报告正文，也不新增事件类型。`label` 由 `describeCall()` 统一生成，格式稳定：
 *
 *   review(codex,deep) --uncommitted
 *   review(codex) --base main
 *   review(deep-dive) --commit abc1234 +instructions「只看并发…」
 *
 * 同一份 projection 还折进 `turn/start` / `turn/end` / `workspace/changes`，让客户端知道
 * 「这一轮有没有文件改动」——官方 `@deepseek-ai/dsh-workspace-changes` 只在确实有改动时
 * 才追加 `workspace/changes`，所以最新 turn 没有这个事件就等于没有改动。宿主没装那个
 * 插件时 `changesEnabled=false`，客户端会退回「只在对话非空时显示」，不会误藏。
 */

/** 客户端 `useProjection(key)` 读取的键；改这个值等于换一份数据，必须同步改 client/client.js。 */
export const REVIEW_STATUS_KEY = 'dsh-review/status';

/** `runs` 只保留最近这么多轮；`rounds` 仍然记录总数，不受裁剪影响。 */
export const REVIEW_RUNS_KEPT = 30;

/** `stateVersion`：fold 语义或持久化字段变化时加一，旧缓存会被丢弃重折。 */
export const REVIEW_STATUS_VERSION = 2;

/**
 * 本进程的启动时间与身份。
 *
 * 持久化缓存可能来自上一次宿主进程：里面若有 `running` 的 review，说明进程在评审途中
 * 退出了，这些轮次不会再有 `job/settled` 事件。缓存回读时按 `bootId` 把它们标成
 * `interrupted`；从会话日志重新 fold 时则按事件时间早于进程启动判断。否则状态条会
 * 永远显示一个几小时前开始、还在计时的「评审中」。
 */
const PROCESS_STARTED_AT = Date.now();
const PROCESS_BOOT_ID = `${PROCESS_STARTED_AT.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** 评审范围；`unknown` 只会在 label 不合约时出现（例如自定义 job 也用了 review kind）。 */
export const REVIEW_SCOPES = ['uncommitted', 'base', 'commit', 'unknown'];

const CALL_PREFIX = /^review\(([^)]*)\)\s+(--uncommitted|--base\s+(\S+)|--commit\s+(\S+))/;

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value, fallback = 0) {
	return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function trimString(value) {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * 从 job label 解析评审者与范围。
 *
 * label 是插件自己拼的，所以这里不做模糊猜测：认不出就返回 `unknown` + 空评审者，
 * 状态条仍会显示轮数，只是不展示名字。
 *
 * @param {unknown} label - `describeCall()` 生成的 job 标签。
 * @returns {{ reviewers: string[], scope: string, scopeRef: string }}
 */
export function parseReviewLabel(label) {
	const text = typeof label === 'string' ? label : '';
	const match = CALL_PREFIX.exec(text);
	if (match === null) return { reviewers: [], scope: 'unknown', scopeRef: '' };

	const reviewers = match[1]
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	if (match[2] === '--uncommitted') return { reviewers, scope: 'uncommitted', scopeRef: '' };
	if (match[3] !== undefined) return { reviewers, scope: 'base', scopeRef: match[3] };
	return { reviewers, scope: 'commit', scopeRef: match[4] ?? '' };
}

function outcomeOf(status) {
	if (status === 'completed' || status === 'failed' || status === 'killed') return status;
	return 'failed';
}

function mergeReviewers(existing, incoming) {
	const next = [...existing];
	for (const id of incoming) if (id.length > 0 && !next.includes(id)) next.push(id);
	return next;
}

function capRuns(runs) {
	if (runs.length <= REVIEW_RUNS_KEPT) return runs;
	// 正在跑的那几轮不能被裁掉：它们的 settled 事件还要回填状态。
	const running = runs.filter((run) => run.status === 'running');
	const settled = runs.filter((run) => run.status !== 'running');
	const keepSettled = Math.max(0, REVIEW_RUNS_KEPT - running.length);
	const kept = [...settled.slice(Math.max(0, settled.length - keepSettled)), ...running];
	return kept.sort((left, right) => left.startedAt - right.startedAt);
}

function runFromRegistration(data, round) {
	const parsed = parseReviewLabel(data.label);
	const startedAt = Number.isFinite(data.startedAt) ? data.startedAt : 0;
	return {
		id: String(data.jobId ?? ''),
		round,
		label: typeof data.label === 'string' ? data.label : '',
		reviewers: parsed.reviewers,
		scope: parsed.scope,
		scopeRef: parsed.scopeRef,
		startedAt,
		status: 'running',
	};
}

/**
 * 空状态；投影 init 与损坏缓存兜底共用。
 *
 * @param {boolean} trackWorkspaceChanges - 宿主是否提供 `workspaceChanges` 能力。
 */
export function createReviewStatusState(trackWorkspaceChanges = true) {
	return {
		bootId: PROCESS_BOOT_ID,
		changesEnabled: trackWorkspaceChanges === true,
		rounds: 0,
		running: 0,
		runs: [],
		reviewers: [],
		active: {},
		currentTurn: 0,
		inTurn: false,
		changesTurn: 0,
	};
}

/**
 * 纯 fold：只认 review 的 job 生命周期事件，其他事件原样返回同一个引用。
 *
 * `active` 是内部字段（jobId → true），用来在 `runs` 被裁剪后仍能正确递减 running；
 * 它不会出现在 wire view 里。
 *
 * @param {ReturnType<typeof createReviewStatusState>} state - 当前折叠状态。
 * @param {{ type?: string, time?: number, data?: unknown }} event - 一条已提交的会话事件。
 * @returns 新状态（无关事件返回原引用）。
 */
export function applyReviewStatus(state, event) {
	if (!isRecord(event) || !isRecord(event.data)) return state;
	const data = event.data;

	// 官方 workspace-changes 只在确实有改动时追加这个事件；记下轮次就够客户端判断。
	if (event.type === 'workspace/changes') {
		const turn = nonNegativeInteger(data.turn, 0);
		if (turn <= state.changesTurn) return state;
		return { ...state, changesTurn: turn };
	}
	if (event.type === 'turn/start') {
		const turn = nonNegativeInteger(data.turn, 0);
		if (turn <= 0) return state;
		const currentTurn = Math.max(state.currentTurn, turn);
		if (currentTurn === state.currentTurn && state.inTurn === true) return state;
		return { ...state, currentTurn, inTurn: true };
	}
	if (event.type === 'turn/end') {
		const turn = nonNegativeInteger(data.turn, state.currentTurn);
		const currentTurn = Math.max(state.currentTurn, turn);
		if (currentTurn === state.currentTurn && state.inTurn === false) return state;
		return { ...state, currentTurn, inTurn: false };
	}

	if (event.type === 'job/registered') {
		if (data.kind !== 'review') return state;
		const round = state.rounds + 1;
		const run = runFromRegistration(data, round);
		const active = { ...state.active, [run.id]: true };
		return {
			...state,
			rounds: round,
			running: state.running + 1,
			runs: capRuns([...state.runs, run]),
			reviewers: mergeReviewers(state.reviewers, run.reviewers),
			active,
		};
	}

	if (event.type === 'job/settled') {
		if (data.kind !== 'review') return state;
		const id = String(data.jobId ?? '');
		const wasActive = state.active[id] === true;
		if (!wasActive) return state;

		const active = { ...state.active };
		delete active[id];
		const finishedAt = Number.isFinite(data.finishedAt) ? data.finishedAt : Number.isFinite(event.time) ? event.time : 0;
		let changed = false;
		const runs = state.runs.map((run) => {
			if (run.id !== id) return run;
			changed = true;
			return {
				...run,
				status: outcomeOf(data.status),
				finishedAt,
				...(typeof data.detail === 'string' && data.detail.length > 0 ? { detail: data.detail } : {}),
			};
		});
		return {
			...state,
			running: Math.max(0, state.running - 1),
			runs: changed ? runs : state.runs,
			active,
		};
	}

	return state;
}

/**
 * 只把客户端需要的字段送出去，不暴露 active。
 *
 * 从会话日志首次 fold 时，`job/registered` 一定先于本进程启动（例如打开一个旧会话），
 * 没有对应 `job/settled` 的轮次会被折成 running。这里按 `startedAt` 再把它们改判为
 * `interrupted`，但**保留后续 settle 已改成 completed 的轮次**——旧会话的正常历史不能
 * 因为时间早而被误报成中断。
 */
export function reviewStatusView(state, changesEnabled = state.changesEnabled) {
	let stale = 0;
	const runs = state.runs.map((run) => {
		if (run.status === 'running' && run.startedAt > 0 && run.startedAt < PROCESS_STARTED_AT) {
			stale += 1;
			return { ...run, status: 'interrupted' };
		}
		return run;
	});
	return {
		rounds: state.rounds,
		running: Math.max(0, state.running - stale),
		runs,
		reviewers: state.reviewers,
		changes: {
			enabled: changesEnabled === true,
			currentTurn: state.currentTurn,
			inTurn: state.inTurn === true,
			changesTurn: state.changesTurn,
		},
	};
}

function normalizeRun(value) {
	if (!isRecord(value)) return undefined;
	const id = trimString(value.id);
	if (id.length === 0) return undefined;
	const scope = REVIEW_SCOPES.includes(value.scope) ? value.scope : 'unknown';
	const status = ['running', 'completed', 'failed', 'killed', 'interrupted'].includes(value.status) ? value.status : 'failed';
	const reviewers = Array.isArray(value.reviewers)
		? value.reviewers.filter((entry) => typeof entry === 'string' && entry.length > 0).slice(0, 40)
		: [];
	const run = {
		id,
		round: nonNegativeInteger(value.round),
		label: typeof value.label === 'string' ? value.label : '',
		reviewers,
		scope,
		scopeRef: typeof value.scopeRef === 'string' ? value.scopeRef : '',
		startedAt: nonNegativeInteger(value.startedAt),
		status,
	};
	if (Number.isFinite(value.finishedAt)) run.finishedAt = value.finishedAt;
	if (typeof value.detail === 'string' && value.detail.length > 0) run.detail = value.detail;
	return run;
}

/**
 * 持久化缓存回读时的规范化：字段缺一块也不能把客户端打崩，所以坏值一律降级。
 *
 * @param {unknown} value - 缓存里的 state。
 * @returns 可直接继续 fold 的状态。
 */
export function normalizeReviewStatusState(value, trackWorkspaceChanges = true) {
	if (!isRecord(value)) return createReviewStatusState(trackWorkspaceChanges);
	const sameProcess = value.bootId === undefined || value.bootId === PROCESS_BOOT_ID;
	let runs = Array.isArray(value.runs) ? value.runs.map(normalizeRun).filter((run) => run !== undefined).slice(-REVIEW_RUNS_KEPT) : [];
	if (!sameProcess) {
		// 上一进程留下的 running 不可能再 settlement；保留轮次，但别让状态条一直计时。
		runs = runs.map((run) => (run.status === 'running' ? { ...run, status: 'interrupted' } : run));
	}
	const reviewers = Array.isArray(value.reviewers)
		? value.reviewers.filter((entry) => typeof entry === 'string' && entry.length > 0).slice(0, 40)
		: [];
	const active = {};
	if (sameProcess && isRecord(value.active)) {
		for (const [id, flag] of Object.entries(value.active)) if (flag === true && id.length > 0) active[id] = true;
	}
	return {
		bootId: PROCESS_BOOT_ID,
		changesEnabled: trackWorkspaceChanges === true,
		rounds: Math.max(nonNegativeInteger(value.rounds, 0), runs.length),
		running: sameProcess ? Math.max(nonNegativeInteger(value.running, 0), Object.keys(active).length) : 0,
		runs,
		reviewers,
		active,
		currentTurn: nonNegativeInteger(value.currentTurn, 0),
		inTurn: value.inTurn === true,
		changesTurn: nonNegativeInteger(value.changesTurn, 0),
	};
}

/** 极小的 zod 兼容壳：宿主目前只调 `.parse()`，顺手补一个 `.safeParse()` 防止升级后换接口。 */
function schemaOf(parse) {
	return {
		parse,
		safeParse(value) {
			try {
				return { success: true, data: parse(value) };
			} catch (error) {
				return { success: false, error };
			}
		},
	};
}

/**
 * 生成交给 `ctx.sessionProjections.register()` 的投影定义。
 *
 * `stateSchema` / `viewSchema` 只被宿主调用 `.parse()`。这里用极小的鸭子类型实现，
 * 避免为了一个状态条把 zod 变成插件的运行时依赖；校验逻辑本身还是走本文的 normalize。
 *
 * @param {{ trackWorkspaceChanges?: boolean }} options - 宿主是否提供 workspaceChanges 能力。
 * @returns 可直接注册的 projection definition。
 */
export function createReviewStatusProjection(options = {}) {
	// 允许传函数：workspaceChanges 是可选服务，晚于本插件注册时也要能开启改动检测。
	const track = typeof options.trackWorkspaceChanges === 'function'
		? options.trackWorkspaceChanges
		: () => options.trackWorkspaceChanges !== false;
	return {
		key: REVIEW_STATUS_KEY,
		stateSchema: schemaOf((value) => normalizeReviewStatusState(value, track())),
		init: () => createReviewStatusState(track()),
		apply: applyReviewStatus,
		wire: {
			viewSchema: schemaOf((value) => value),
			view: (state) => reviewStatusView(state, track()),
		},
		stateVersion: REVIEW_STATUS_VERSION,
	};
}

/** 默认定义（测试与不关心 workspace-changes 的宿主使用）。 */
export const reviewStatusProjection = createReviewStatusProjection();