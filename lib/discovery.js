/**
 * 模型发现与按需指名。
 *
 * 这一层回答的是「用户已经在 DSH 里配置了哪些模型，能不能直接拿来评审」：
 *
 * - **定义层**（端点、密钥、上下文、模态）永远属于 DSH 的 provider 配置，
 *   插件不复制、不覆盖，也拿不到密钥——它只问 `ctx.llm` 有什么；
 * - **选用层**：`discover` 把指定 provider 下的模型自动变成评审者；
 *   `adHoc` 允许工具参数直接写 `provider/model` 指名任意已注册模型。
 *
 * 解析发生在每次工具调用时（异步、不缓存），所以 DSH 那边加/删模型立刻生效，
 * 不会出现「插件里记的模型列表过期了」这种问题。
 */

import { applySelection, emptySelectionMessage } from './settings.js';

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/* ────────────────────────────── glob ────────────────────────────── */

/** 极简 glob：`*` / `?`，大小写不敏感。够用来写 `*embed*`、`qwen*` 这类过滤。 */
export function globToRegExp(pattern) {
	const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp(`^${escaped}$`, 'i');
}

/**
 * 模式是否命中某个模型。带 `/` 的模式按 `provider/model` 匹配，不带 `/` 的按裸
 * model 匹配——写 `*embed*` 就能同时滤掉所有 provider 下的 embedding 模型。
 */
export function matchesPattern(pattern, provider, model) {
	const text = String(pattern);
	const target = text.includes('/') ? `${provider}/${model}` : model;
	return globToRegExp(text).test(target);
}

function matchesAny(patterns, provider, model) {
	return Array.isArray(patterns) && patterns.some((pattern) => matchesPattern(pattern, provider, model));
}

/* ────────────────────────────── 池子 ────────────────────────────── */

/** 一次调用内的 model 列表缓存：同一 provider 只问一次。 */
function makeModelLister(ctx, discover, signal, notes) {
	const cache = new Map();
	let llm;
	try {
		llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm;
	} catch {
		llm = undefined;
	}
	return {
		llm,
		async list(provider, { required = false } = {}) {
			if (cache.has(provider)) return cache.get(provider);
			if (llm === undefined || typeof llm.listModels !== 'function') {
				if (required) throw new Error('ctx.llm 服务不可用，无法解析 provider/model');
				cache.set(provider, undefined);
				return undefined;
			}
			const promise = Promise.race([
				Promise.resolve(llm.listModels(provider)),
				new Promise((resolve) => {
					const timer = setTimeout(() => resolve('timeout'), discover.listModelsTimeoutMs);
					timer.unref?.();
				}),
			]);
			let models;
			try {
				models = await promise;
			} catch (error) {
				if (required) throw new Error(`provider "${provider}" 的模型列表获取失败：${messageOf(error)}`);
				notes.push(`provider "${provider}" 的模型列表获取失败，已跳过：${messageOf(error)}`);
				cache.set(provider, undefined);
				return undefined;
			}
			if (models === 'timeout') {
				if (required) throw new Error(`provider "${provider}" 的模型列表超过 ${discover.listModelsTimeoutMs}ms 未返回`);
				notes.push(`provider "${provider}" 的模型列表超过 ${discover.listModelsTimeoutMs}ms 未返回，已跳过`);
				cache.set(provider, undefined);
				return undefined;
			}
			const list = Array.isArray(models) ? models.filter((model) => typeof model?.id === 'string' && model.id.length > 0) : [];
			cache.set(provider, list);
			return list;
		},
		registered() {
			if (llm === undefined || typeof llm.listProviders !== 'function') return [];
			try {
				const providers = llm.listProviders();
				return Array.isArray(providers) ? providers.filter((entry) => typeof entry?.id === 'string' && entry.id.length > 0) : [];
			} catch {
				return [];
			}
		},
	};
}

/** 标签模板：`{provider}`、`{providerName}`、`{model}`、`{name}`。 */
function renderLabel(template, provider, providerName, model) {
	return String(template)
		.replace(/\{provider\}/g, provider)
		.replace(/\{providerName\}/g, providerName ?? provider)
		.replace(/\{model\}/g, model.id)
		.replace(/\{name\}/g, model.name ?? model.id);
}

/** 把发现出来的模型变成 llm 评审者。 */
function toReviewer(discover, provider, providerName, model) {
	return {
		id: `${provider}/${model.id}`,
		kind: 'llm',
		source: 'discover',
		label: renderLabel(discover.label, provider, providerName, model),
		enabled: true,
		provider,
		model: model.id,
		needsPacket: true,
	};
}

/* ────────────────────────────── 解析 ────────────────────────────── */

/** 拆 `provider/model`；不是这个形状就返回 undefined。 */
function splitQualified(id) {
	const index = String(id).indexOf('/');
	if (index <= 0 || index === String(id).length - 1) return undefined;
	return { provider: String(id).slice(0, index), model: String(id).slice(index + 1) };
}

/**
 * 解析本次调用要用的评审者。
 *
 * @returns `{ reviewers, notes }`；`notes` 是要写进报告脚注的说明（展开了什么、
 *          跳过了什么），让「这次到底用了哪些模型」永远可追。
 */
export async function resolveReviewerSelection(ctx, settings, mode, requested, signal) {
	const discover = settings.discover;
	const notes = [];
	const byId = new Map();
	const aliases = new Map();

	for (const reviewer of settings.reviewers) {
		if (reviewer.enabled) byId.set(reviewer.id, reviewer);
	}

	const lister = makeModelLister(ctx, discover, signal, notes);
	const providerNames = new Map(lister.registered().map((entry) => [entry.id, entry.name]));

	// 1) 自动展开
	const discovered = [];
	if (discover.enabled) {
		if (lister.llm === undefined) {
			notes.push('discover 已打开，但 ctx.llm 服务不可用（需要 @deepseek-ai/dsh-llm 与至少一个 provider adapter），未能展开模型');
		} else {
			const registered = [...providerNames.keys()];
			const configured = discover.providers ?? registered;
			const usable = configured.filter((provider) => registered.length === 0 || registered.includes(provider));
			for (const provider of configured) {
				if (registered.length > 0 && !registered.includes(provider)) notes.push(`discover 指定的 provider "${provider}" 当前没有注册，已跳过`);
			}
			for (const provider of usable) {
				if (signal?.aborted) break;
				const models = await lister.list(provider);
				if (models === undefined) continue;
				for (const model of models) {
					if (matchesAny(discover.exclude, provider, model.id)) continue;
					if (discover.include.length > 0 && !matchesAny(discover.include, provider, model.id)) continue;
					const reviewer = toReviewer(discover, provider, providerNames.get(provider), model);
					if (byId.has(reviewer.id)) continue;
					byId.set(reviewer.id, reviewer);
					discovered.push(reviewer.id);
				}
			}
			if (discovered.length > 0) notes.push(`discover：已把 ${discovered.length} 个模型纳入评审者（${discovered.join('、')}）`);
		}
	}

	// 2) 裸模型名别名：唯一才认，重名就不猜。
	const bareCount = new Map();
	for (const reviewer of byId.values()) {
		if (reviewer.kind !== 'llm' || typeof reviewer.model !== 'string') continue;
		bareCount.set(reviewer.model, (bareCount.get(reviewer.model) ?? 0) + 1);
	}
	for (const reviewer of byId.values()) {
		if (reviewer.kind !== 'llm' || typeof reviewer.model !== 'string') continue;
		if (bareCount.get(reviewer.model) === 1) aliases.set(reviewer.model, reviewer.id);
	}

	// 3) 按需指名：只有查不到、又长得像 provider/model 时才去问 llm。
	const adHoc = [];
	const resolveOne = async (id) => {
		const direct = byId.get(id);
		if (direct !== undefined) return direct;
		const alias = aliases.get(id);
		if (alias !== undefined) return byId.get(alias);
		if (!discover.adHoc) return undefined;
		const split = splitQualified(id);
		if (split === undefined) return undefined;
		if (matchesAny(discover.exclude, split.provider, split.model)) return undefined;
		const models = await lister.list(split.provider, { required: false });
		if (models === undefined || !models.some((model) => model.id === split.model)) return undefined;
		const model = models.find((entry) => entry.id === split.model);
		const reviewer = { ...toReviewer(discover, split.provider, providerNames.get(split.provider), model), id, source: 'adhoc' };
		byId.set(id, reviewer);
		adHoc.push(id);
		return reviewer;
	};

	// 默认集合 = `defaultReviewers`（在 applySelection 里作为第三优先级）+ 只来自 discover
	// 且显式 `inDefault: true` 的模型。**不再回落到「全部启用」**：一个都不选就是不启用，
	// 空集合会在下面报错，而不是悄悄把配置里所有评审者都跑一遍。
	const defaultIds = discover.enabled && discover.inDefault ? [...discovered] : [];

	// 先用统一的优先级规则定出候选 id（池子里已有的直接命中，剩下的走别名 / 按需指名）。
	const staged = applySelection({ byId, defaultIds, settings, mode, requested });
	const selected = [...staged.selected];
	const unknown = [];
	for (const id of staged.unknown) {
		const reviewer = await resolveOne(id);
		if (reviewer === undefined) unknown.push(id);
		else if (!selected.includes(reviewer)) selected.push(reviewer);
	}

	if (unknown.length > 0) throw new Error(await buildUnknownMessage({ settings, unknown, byId, lister, providerNames }));
	if (selected.length === 0) throw new Error(await buildEmptyMessage({ settings, lister, providerNames }));
	if (adHoc.length > 0) notes.push(`按需指名：${adHoc.join('、')}（来自 DSH 已注册模型，不在插件配置里）`);

	return { reviewers: selected, notes };
}

/* ────────────────────────────── 报错文案 ────────────────────────────── */

const MAX_HINTED = 12;

/** 把「DSH 里现在到底有什么」写进报错，模型看到就能自己改对。 */
async function describeRegistered(lister, providerNames, limit = MAX_HINTED) {
	if (lister.llm === undefined) return '（ctx.llm 不可用，无法列出已注册模型）';
	const providers = [...providerNames.keys()];
	if (providers.length === 0) return '（当前没有已注册的 provider）';
	const qualified = [];
	for (const provider of providers) {
		const models = await lister.list(provider);
		for (const model of models ?? []) {
			qualified.push(`${provider}/${model.id}`);
			if (qualified.length >= limit) break;
		}
		if (qualified.length >= limit) break;
	}
	return qualified.length > 0 ? `当前 DSH 已注册的模型（最多列 ${limit} 个）：${qualified.join('、')}` : '（已注册的 provider 没有对外声明模型）';
}

async function buildUnknownMessage({ settings, unknown, byId, lister, providerNames }) {
	const available = [...byId.keys()];
	const lines = [`未知或未启用的评审者：${unknown.join(', ')}。`];
	if (available.length > 0) lines.push(`插件配置里的评审者：${available.slice(0, MAX_HINTED).join(', ')}${available.length > MAX_HINTED ? ' …' : ''}。`);
	if (settings.discover.adHoc) lines.push(`也可以用 \`provider/model\` 直接指名 DSH 里已注册的模型。${await describeRegistered(lister, providerNames)}`);
	else lines.push('（config 里 discover.adHoc 已关闭，只能使用上面列出的评审者）');
	return lines.join('\n');
}

async function buildEmptyMessage({ settings, lister, providerNames }) {
	const lines = [emptySelectionMessage()];
	if (settings.discover.enabled) lines.push(await describeRegistered(lister, providerNames));
	return lines.join('\n');
}