/**
 * 配置归一化。
 *
 * 插件对外只有一个 `config` 块，里面混了四类东西：
 *
 * - 可调项（waitMs、maxDiffChars……）：非法值退回默认，别让一次手写配置把插件打瘫；
 * - `agents` / `models` / `reviewers`：三种写法最终都展开成同一张「评审者」表；
 * - `modes`：评审模式（强度、提示词、评审者集合、策略）；
 * - 结构性的错误（比如一个 kind: llm 却没有 model）只丢那一条并记 warning——
 *   工具照常注册，warning 会出现在工具描述与报错里，比整个插件加载失败好定位。
 */

/**
 * CLI 智能体预设。
 *
 * `command` 是 argv 模板，占位符在 buildCommand 里展开成「零到多个」参数：
 * 这样 `{range}`、`{model}`、`{promptArg}` 在不需要时直接消失，不必为每个
 * 预设写一套拼装逻辑。
 */
export const CLI_PRESETS = {
	codex: {
		label: 'Codex CLI',
		executable: 'codex',
		modelFlag: ['-m'],
		// `codex exec review` 自己会跑 git，所以不需要插件喂 diff（needsPacket=false）。
		command: ['{exe}', 'exec', 'review', '{range}', '{ephemeral}', '{model}', '{reportArg}', '{extra}', '{promptArg}'],
		capture: 'report',
		promptVia: 'argv',
		needsPacket: false,
		// CLI 层面 PROMPT 与范围开关互斥：给了 PROMPT 就不能再带范围。范围优先——
		// 宁可丢掉模式的提示词，也不能悄悄把评审范围从「提交 X」变成「未提交」。
		promptReplacesRange: true,
	},
	claude: {
		label: 'Claude Code',
		executable: 'claude',
		modelFlag: ['--model'],
		command: ['{exe}', '--print', '--output-format', 'text', '{model}', '{extra}', '{prompt}'],
		capture: 'stdout',
		promptVia: 'argv',
		needsPacket: true,
	},
	gemini: {
		label: 'Gemini CLI',
		executable: 'gemini',
		modelFlag: ['-m'],
		command: ['{exe}', '-p', '{prompt}', '{model}', '{extra}'],
		capture: 'stdout',
		promptVia: 'argv',
		needsPacket: true,
	},
	opencode: {
		label: 'opencode',
		executable: 'opencode',
		modelFlag: ['--model'],
		command: ['{exe}', 'run', '{model}', '{extra}', '{prompt}'],
		capture: 'stdout',
		promptVia: 'argv',
		needsPacket: true,
	},
	cursor: {
		label: 'Cursor Agent',
		executable: 'cursor-agent',
		modelFlag: ['--model'],
		command: ['{exe}', '--print', '{model}', '{extra}', '{prompt}'],
		capture: 'stdout',
		promptVia: 'argv',
		needsPacket: true,
	},
	custom: {
		label: 'Custom CLI',
		executable: undefined,
		modelFlag: ['--model'],
		command: [],
		capture: 'stdout',
		promptVia: 'argv',
		needsPacket: true,
	},
};

/** 可调项默认值；profile 的 patch 层同名键覆盖。 */
export const DEFAULTS = {
	/** 默认评审者 id；不写 = 所有启用的评审者。 */
	defaultReviewers: undefined,
	/** 默认模式名；不写 = 不套任何模式（「不做任何设置」）。 */
	defaultMode: undefined,
	/** 是否把模式的 when 策略写进系统提示词；默认关闭 = 不干预模型行为。 */
	injectPolicy: false,
	/** 回给模型的评审结论最大字符数，超出按首尾截断并给出完整报告路径。 */
	maxResultChars: 80_000,
	/** 喂给「需要 diff」的评审者的变更正文上限（字符）。 */
	maxDiffChars: 160_000,
	/** 单个文件 diff 的字符上限，超出只保留头部并注明。 */
	maxFileDiffChars: 40_000,
	/**
	 * 以 argv 投递提示词的 CLI 评审者的单参数字节上限。
	 *
	 * Linux 对「单个参数」的限制约 128 KiB（macOS 是整条 argv 256 KiB），而默认
	 * diff 预算 16 万字符在中文下能到 48 万字节——不设这道闸，claude / gemini /
	 * opencode / cursor 这些只能收 argv 的预设会直接 E2BIG 起不来。
	 */
	maxArgBytes: 96 * 1024,
	/** 最多纳入 diff 的文件数；超出只列文件名。 */
	maxDiffFiles: 60,
	/** 未跟踪新文件的正文上限（每个文件）。 */
	maxUntrackedFileChars: 20_000,
	/** 前台等待时长；超时把 job id 交给模型，不再阻塞。 */
	waitMs: 120_000,
	/** 兜底墙钟上限；`0` 表示不限制。 */
	hardTimeoutMs: 3_600_000,
	/** 评审者 stdout/stderr 的保留字节数（只用于失败诊断）。 */
	collectMaxBytes: 256 * 1024,
	/** 诊断输出的兜底落盘上限。 */
	spillMaxBytes: 8 * 1024 * 1024,
	/** 额外透传给评审进程的环境变量名（凭据类变量会被 subprocess 服务默认抹掉）。 */
	envPassthrough: [],
	/** 评审结论语言：zh / en / auto（跟随附加指令，没有指令时用中文）。 */
	language: 'auto',
};

/** 内置强度短语：模式没写 prompt 时至少给出强度语义。 */
const STRENGTH_PROMPTS = {
	light: '这次是轻量评审：只报告会导致故障、数据损坏或安全问题的高置信缺陷，最多 5 条，不要罗列风格偏好与重构建议。',
	standard: '',
	deep: '这次是深度评审：逐文件推演失败路径与边界条件，指出并发、错误处理、资源释放、兼容性与测试缺口；每个问题给出证据（文件:行）与复现路径，不要客气。',
};

const STRENGTHS = new Set(['light', 'standard', 'deep']);
const WHEN_VALUES = new Set(['always', 'complex', 'never']);
const KINDS = new Set(['cli', 'llm', 'subagent']);

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function pickString(raw, key, fallback) {
	const value = text(raw?.[key]);
	return value.length > 0 ? value : fallback;
}

function pickNumber(raw, key, fallback, { min = 0, integer = true } = {}) {
	const value = raw?.[key];
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min) return fallback;
	return integer ? Math.floor(value) : value;
}

function pickBool(raw, key, fallback) {
	return typeof raw?.[key] === 'boolean' ? raw[key] : fallback;
}

function pickStringArray(raw, key) {
	const value = raw?.[key];
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
}

function pickArgs(raw, key) {
	const value = raw?.[key];
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === 'string').map((entry) => entry);
}

/** `id` 里只留安全字符：它要进 argv 与 job 标签的展示。 */
function normalizeId(value) {
	const trimmed = text(value);
	if (trimmed.length === 0) return '';
	if (trimmed.length > 64 || !/^[A-Za-z0-9._:@/-]+$/.test(trimmed)) return '';
	return trimmed;
}

/** 由模型/预设名推导 id（`bainian/qwen3.8-max` → `qwen3.8-max`）。 */
function deriveId(seed) {
	const base = text(seed).split(/[/\\]/).pop() ?? '';
	const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
	return normalizeId(cleaned);
}

/* ────────────────────────────── 评审者 ────────────────────────────── */

/**
 * 归一化一条评审者定义。三种来源（agents / models / reviewers）共用这里，
 * 只把「来源默认值」在调用方填好。
 */
function normalizeReviewer(raw, source, warnings) {
	const kind = pickString(raw, 'kind', source);
	if (!KINDS.has(kind)) {
		warnings.push(`${kind || '(未指定 kind)'} 不是合法类型（cli / llm / subagent），该评审者已忽略`);
		return undefined;
	}
	const id = normalizeId(raw.id);
	if (id.length === 0) {
		warnings.push(`评审者 id 缺失或含非法字符（${String(raw.id ?? '')}），已忽略`);
		return undefined;
	}

	if (kind === 'cli') {
		const presetName = pickString(raw, 'preset', 'custom');
		const preset = CLI_PRESETS[presetName];
		if (preset === undefined) {
			warnings.push(`评审者 ${id}：未知 CLI 预设 "${presetName}"，已忽略`);
			return undefined;
		}
		const command = pickArgs(raw, 'command');
		const effective = command.length > 0 ? command : preset.command;
		if (effective.length === 0) {
			warnings.push(`评审者 ${id}：preset: custom 必须给 command（argv 模板），已忽略`);
			return undefined;
		}
		const capture = pickString(raw, 'capture', preset.capture);
		if (capture !== 'stdout' && capture !== 'report') {
			warnings.push(`评审者 ${id}：capture 只能是 stdout 或 report，已忽略`);
			return undefined;
		}
		if (capture === 'report' && !effective.includes('{reportArg}') && !effective.includes('{report}')) {
			warnings.push(`评审者 ${id}：capture: report 的 command 里必须有 {report}，已忽略`);
			return undefined;
		}
		const promptVia = pickString(raw, 'promptVia', preset.promptVia);
		return {
			id,
			kind,
			source,
			label: pickString(raw, 'label', preset.label ?? id),
			enabled: pickBool(raw, 'enabled', true),
			preset: presetName,
			executable: pickString(raw, 'executable', preset.executable),
			command: effective,
			capture,
			promptVia: promptVia === 'stdin' ? 'stdin' : 'argv',
			model: pickString(raw, 'model', undefined),
			modelFlag: pickArgs(raw, 'modelFlag').length > 0 ? pickArgs(raw, 'modelFlag') : preset.modelFlag,
			extraArgs: pickArgs(raw, 'extraArgs'),
			envPassthrough: pickStringArray(raw, 'envPassthrough') ?? [],
			timeoutMs: pickNumber(raw, 'timeoutMs', undefined, { min: 1 }),
			// 模板自己收 PROMPT（codex 的 {promptArg}）说明它自己会读仓库，不必喂 diff。
			needsPacket: pickBool(raw, 'needsPacket', preset.needsPacket && !effective.includes('{promptArg}')),
			// 带 {promptArg} 的模板按「codex 形状」处理：PROMPT 与范围开关互斥。
			// 这条推断不能省——自定义的 codex 包装脚本正是这么写的，否则它们会同时收到
			// 范围开关和 PROMPT，被 CLI 判为非法组合。
			promptReplacesRange: pickBool(raw, 'promptReplacesRange', preset.promptReplacesRange === true || effective.includes('{promptArg}')),
		};
	}

	if (kind === 'llm') {
		const provider = pickString(raw, 'provider', undefined);
		const model = pickString(raw, 'model', undefined);
		if (provider === undefined || model === undefined) {
			warnings.push(`评审者 ${id}：kind: llm 必须同时给 provider 与 model，已忽略`);
			return undefined;
		}
		const llm = isRecord(raw.llm) ? raw.llm : {};
		return {
			id,
			kind,
			source,
			label: pickString(raw, 'label', model),
			enabled: pickBool(raw, 'enabled', true),
			provider,
			model,
			maxTokens: pickNumber(llm, 'maxTokens', undefined, { min: 1 }),
			temperature: pickNumber(llm, 'temperature', undefined, { min: 0, integer: false }),
			timeoutMs: pickNumber(raw, 'timeoutMs', undefined, { min: 1 }),
			needsPacket: true,
		};
	}

	const provider = pickString(raw, 'provider', 'spawn');
	const agentProvider = pickString(raw, 'agentProvider', undefined);
	const agentModel = pickString(raw, 'agentModel', undefined);
	return {
		id,
		kind,
		source,
		label: pickString(raw, 'label', 'DSH 子智能体'),
		enabled: pickBool(raw, 'enabled', true),
		provider,
		agentProvider,
		agentModel,
		maxDepth: pickNumber(raw, 'maxDepth', undefined, { min: 0 }),
		persona: pickString(raw, 'persona', undefined),
		toolFilter: isRecord(raw.toolFilter) ? raw.toolFilter : undefined,
		timeoutMs: pickNumber(raw, 'timeoutMs', undefined, { min: 1 }),
		needsPacket: true,
	};
}

/**
 * 展开 agents / models / reviewers 三个来源。
 *
 * - `agents`：CLI 智能体简写，id 默认取预设名；
 * - `models`：LLM 简写，id 默认取模型名，一律走 DSH 自己的 llm 服务；
 * - `reviewers`：完整定义，可覆盖同名简写。
 */
function collectReviewers(raw, warnings) {
	const out = new Map();

	const add = (list, source, defaults, derive) => {
		if (!Array.isArray(list)) return;
		for (const entry of list) {
			if (!isRecord(entry)) {
				warnings.push(`${source} 里有一条不是对象，已忽略`);
				continue;
			}
			// 简写允许省略 id：agents 用预设名，models 用模型名。
			const withId = text(entry.id).length > 0 ? entry : { ...entry, id: derive(entry) };
			const reviewer = normalizeReviewer({ ...defaults, ...withId }, source, warnings);
			if (reviewer === undefined) continue;
			if (out.has(reviewer.id) && source !== 'reviewers') {
				warnings.push(`${source} 里有重复的评审者 id "${reviewer.id}"，只保留先出现的那条（显式 reviewers 可以覆盖它）`);
				continue;
			}
			out.set(reviewer.id, reviewer);
		}
	};

	add(raw.agents, 'agents', { kind: 'cli' }, (entry) => deriveId(text(entry.preset) || 'agent'));
	add(raw.models, 'models', { kind: 'llm' }, (entry) => deriveId(text(entry.model) || text(entry.provider) || 'model'));

	// 显式 reviewers：kind 可省略，按写了哪个字段推断。
	if (Array.isArray(raw.reviewers)) {
		for (const entry of raw.reviewers) {
			if (!isRecord(entry)) {
				warnings.push('reviewers 里有一条不是对象，已忽略');
				continue;
			}
			const inferred =
				text(entry.kind) ||
				(entry.subagentProvider !== undefined || entry.agentModel !== undefined
					? 'subagent'
					: entry.provider !== undefined
						? 'llm'
						: 'cli');
			const normalized = normalizeReviewer({ ...entry, kind: inferred }, 'reviewers', warnings);
			if (normalized !== undefined) out.set(normalized.id, normalized);
		}
	}

	// 简写没写 id 的已在 add 里补过，这里保持插入顺序返回。
	return [...out.values()];
}

/* ────────────────────────────── 模式 ────────────────────────────── */

function normalizeMode(name, raw, warnings) {
	const modeName = normalizeId(name);
	if (modeName.length === 0) {
		warnings.push(`模式名 "${String(name)}" 非法（只允许字母数字与 . _ : @ / -），已忽略`);
		return undefined;
	}
	const body = isRecord(raw) ? raw : {};
	const strengthRaw = pickString(body, 'strength', 'standard');
	const strength = STRENGTHS.has(strengthRaw) ? strengthRaw : 'standard';
	if (!STRENGTHS.has(strengthRaw)) {
		warnings.push(`模式 ${modeName}：strength "${strengthRaw}" 未知，按 standard 处理`);
	}
	const whenRaw = text(body.when);
	if (whenRaw.length > 0 && !WHEN_VALUES.has(whenRaw)) {
		warnings.push(`模式 ${modeName}：when "${whenRaw}" 未知（always / complex / never），按未设置处理`);
	}
	const reviewers = pickStringArray(body, 'reviewers');
	return {
		name: modeName,
		label: pickString(body, 'label', modeName),
		description: pickString(body, 'description', undefined),
		strength,
		prompt: pickString(body, 'prompt', undefined),
		reviewers,
		synthesize: pickBool(body, 'synthesize', false),
		synthesizeReviewer: pickString(body, 'synthesizeReviewer', undefined),
		when: WHEN_VALUES.has(whenRaw) ? whenRaw : undefined,
		minChangedLines: pickNumber(body, 'minChangedLines', undefined, { min: 1 }),
	};
}

/* ────────────────────────────── 入口 ────────────────────────────── */

/** 归一化整块配置。返回值永远可用；问题都在 `warnings` 里。 */
export function resolveSettings(config) {
	const raw = isRecord(config) ? config : {};
	const warnings = [];
	const settings = { ...DEFAULTS };

	for (const key of ['maxResultChars', 'maxDiffChars', 'maxFileDiffChars', 'maxDiffFiles', 'maxUntrackedFileChars', 'maxArgBytes', 'waitMs', 'hardTimeoutMs', 'collectMaxBytes', 'spillMaxBytes']) {
		settings[key] = pickNumber(raw, key, DEFAULTS[key]);
	}
	const language = pickString(raw, 'language', DEFAULTS.language).toLowerCase();
	settings.language = ['zh', 'en', 'auto'].includes(language) ? language : DEFAULTS.language;
	settings.injectPolicy = pickBool(raw, 'injectPolicy', DEFAULTS.injectPolicy);
	settings.envPassthrough = pickStringArray(raw, 'envPassthrough') ?? [];

	settings.reviewers = collectReviewers(raw, warnings);

	const requested = pickStringArray(raw, 'defaultReviewers') ?? [];
	const known = new Set(settings.reviewers.filter((reviewer) => reviewer.enabled).map((reviewer) => reviewer.id));
	settings.defaultReviewers = requested.filter((id) => {
		if (known.has(id)) return true;
		warnings.push(`defaultReviewers 里的 "${id}" 不是启用的评审者，已忽略`);
		return false;
	});

	settings.modes = {};
	if (isRecord(raw.modes)) {
		for (const [modeName, modeBody] of Object.entries(raw.modes)) {
			const mode = normalizeMode(modeName, modeBody, warnings);
			if (mode !== undefined) settings.modes[mode.name] = mode;
		}
	}
	const defaultMode = text(raw.defaultMode);
	if (defaultMode.length > 0) {
		if (settings.modes[defaultMode] === undefined) {
			warnings.push(`defaultMode "${defaultMode}" 没有对应的 modes 定义，按未设置处理`);
		} else {
			settings.defaultMode = defaultMode;
		}
	}

	settings.warnings = warnings;
	return settings;
}

/** 解析本次调用用的模式；名字不存在直接报错并列出可选值。 */
export function resolveMode(settings, requested) {
	const name = text(requested);
	if (name.length === 0) return settings.defaultMode === undefined ? undefined : settings.modes[settings.defaultMode];
	const mode = settings.modes[name];
	if (mode === undefined) {
		const available = Object.keys(settings.modes);
		throw new Error(`未知的评审模式 "${name}"。${available.length > 0 ? `可用模式：${available.join(', ')}。` : '当前没有配置任何模式。'}`);
	}
	return mode;
}

/**
 * 选出本次要跑的评审者。优先级：调用方指定 > 模式指定 > defaultReviewers > 全部启用。
 */
export function selectReviewers(settings, mode, requested) {
	const enabled = settings.reviewers.filter((reviewer) => reviewer.enabled);
	if (enabled.length === 0) {
		throw new Error('没有可用的评审者：请在插件 config 里配置 agents / models / reviewers（至少一个 enabled）。');
	}
	const byId = new Map(enabled.map((reviewer) => [reviewer.id, reviewer]));
	const explicit = Array.isArray(requested) ? requested.map((entry) => text(entry)).filter((entry) => entry.length > 0) : [];
	let ids;
	if (explicit.length > 0) ids = explicit;
	else if (mode?.reviewers !== undefined && mode.reviewers.length > 0) ids = mode.reviewers;
	else if (settings.defaultReviewers !== undefined && settings.defaultReviewers.length > 0) ids = settings.defaultReviewers;
	else return enabled;

	const selected = [];
	const unknown = [];
	for (const id of ids) {
		const reviewer = byId.get(id);
		if (reviewer === undefined) unknown.push(id);
		else if (!selected.includes(reviewer)) selected.push(reviewer);
	}
	if (unknown.length > 0) {
		throw new Error(`未知或未启用的评审者：${unknown.join(', ')}。可用：${[...byId.keys()].join(', ')}。`);
	}
	if (selected.length === 0) throw new Error('没有选中任何评审者。');
	return selected;
}

/** 选中集合里是否需要 diff 正文。 */
export function needsPacket(reviewers) {
	return reviewers.some((reviewer) => reviewer.needsPacket);
}

/** 模式的附加提示词（强度语义 + 模式自写 prompt）。 */
export function modePrompt(mode) {
	if (mode === undefined) return undefined;
	const parts = [];
	const strength = STRENGTH_PROMPTS[mode.strength];
	if (strength !== undefined && strength.length > 0) parts.push(strength);
	if (mode.prompt !== undefined) parts.push(mode.prompt);
	return parts.length > 0 ? parts.join('\n\n') : undefined;
}