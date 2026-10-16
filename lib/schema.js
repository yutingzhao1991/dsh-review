/**
 * GUI 配置的宿主半边：声明 Config schema。
 *
 * DSH 的设置表单只认一样东西——插件 Config schema（schemastery）里标了
 * `.volatile()` 的字段。`dsh-settings` 的 `volatileForm(schema)` 会把这些字段投影成
 * 一份浏览器可编辑的表单，写到 profile 的 patch 层并立即生效。
 *
 * 两个刻意的设计：
 *
 * 1. **只声明一部分字段。** schemastery 对未声明的键原样透传，所以 GUI 里只放「扁平
 *    开关与预算」，`agents` / `envPassthrough` 这类仍然只在 YAML 里；`reviewers` /
 *    `modes` 是嵌套结构，用 JSON 文本框进表单（见 client/client.js）。
 * 2. **schema 是可选能力。** schemastery 装在宿主环境里、不在插件目录里（插件是
 *    `link:` 进来的，Node 按真实路径解析依赖），所以这里定向解析：插件目录 → dsh 安装
 *    目录 → 各 profile 目录。全都找不到就返回 undefined——插件照常工作，只是 GUI 里
 *    没有表单，工具描述里会说明这件事。
 */

import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const SCHEMA_PACKAGE = '@deepseek-ai/schemastery';
const require = createRequire(import.meta.url);

/** 可能装着 schemastery 的目录，按「离插件最近」排序。 */
function candidateAnchors() {
	const anchors = [];
	const push = (value) => {
		if (typeof value === 'string' && value.length > 0 && !anchors.includes(value)) anchors.push(value);
	};
	// 宿主自己：argv[1] 是 dsh 的 bin.js，从它往上走能找到安装目录的 node_modules。
	const argv1 = process.argv?.[1];
	if (typeof argv1 === 'string') push(dirname(argv1));
	// profile 目录：即使安装布局变了（桌面版等），profile 里那份也能用。
	const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
	try {
		for (const entry of readdirSync(join(home, 'profiles'))) push(join(home, 'profiles', entry));
	} catch {
		/* 没有 profiles 目录就靠别的锚点 */
	}
	push(process.cwd());
	return anchors;
}

/** 同步拿到 schemastery：Config 必须是模块加载时就能读到的静态导出。 */
function loadSchemastery() {
	// 1) 插件自己的依赖（用户在自己的插件目录装过）
	try {
		return require(SCHEMA_PACKAGE);
	} catch {
		/* 继续找 */
	}
	// 2) 从宿主环境定向解析
	for (const anchor of candidateAnchors()) {
		try {
			const resolved = require.resolve(SCHEMA_PACKAGE, { paths: [anchor] });
			return require(resolved);
		} catch {
			/* 换下一个锚点 */
		}
	}
	return undefined;
}

function buildConfig() {
	const loaded = loadSchemastery();
	if (loaded === undefined) return undefined;
	// CJS 导出就是 schema 工厂本身；ESM 命名空间则挂在 default 上。
	const z = typeof loaded === 'function' ? loaded : (loaded.default ?? loaded);
	if (typeof z?.object !== 'function') return undefined;
	const list = () => z.array(z.string()).volatile();
	const text = () => z.string().volatile();
	const flag = () => z.boolean().volatile();
	const count = () => z.number().volatile();
	/**
	 * 带默认值的写法。
	 *
	 * 只给「缺省即等于插件默认值」的键加 default：这样表单一打开就显示真实生效的数字，
	 * 而不是一片空白让人猜。
	 *
	 * 反过来，**有推断语义的键绝对不能加 default**——`discover.enabled` 靠「有没有写
	 * providers/include」推断，`defaultReviewers` / `defaultMode` 靠 undefined 表示
	 * 「未设置」。给它们塞默认值会把这些语义顶掉（selftest K 段有专门的断言钉住这一点）。
	 */
	const withDefault = (schema, value) => schema.default(value).volatile();
	return z.object({
		// ── 评审行为 ──
		// defaultReviewers / defaultMode 故意没有默认值：undefined = 「未设置」。
		defaultReviewers: list(),
		defaultMode: text(),
		language: withDefault(z.string(), 'auto'),
		injectPolicy: withDefault(z.boolean(), false),
		// ── 预算与超时（默认值必须与 DEFAULTS 一致，selftest 会比对）──
		waitMs: withDefault(z.number(), 120_000),
		// 0 = 不限制：评审跑多久由调用方决定，插件不替它掐表（与 DEFAULTS 一致，selftest 会比对）
		hardTimeoutMs: withDefault(z.number(), 0),
		maxResultChars: withDefault(z.number(), 80_000),
		maxDiffChars: withDefault(z.number(), 160_000),
		maxFileDiffChars: withDefault(z.number(), 40_000),
		maxUntrackedFileChars: withDefault(z.number(), 20_000),
		maxArgBytes: withDefault(z.number(), 96 * 1024),
		// ── 模型发现（叶子逐项 volatile，表单里才是一个字段一格）──
		discover: z.object({
			// enabled / providers 是范围键，靠 undefined 推断，不能给默认值。
			enabled: flag(),
			providers: list(),
			include: withDefault(z.array(z.string()), []),
			exclude: withDefault(z.array(z.string()), []),
			label: withDefault(z.string(), '{model}'),
			inDefault: withDefault(z.boolean(), false),
			adHoc: withDefault(z.boolean(), true),
		}),
		// ── 高级：嵌套结构走 JSON 文本框 ──
		// array/any 这类非 object 类型在 dsh-settings 的 projectForm 里是原样透传的，
		// 所以内容不会被 schema 投影吃掉。
		reviewers: z.array(z.any()).volatile(),
		modes: z.any().volatile(),
	});
}

/** 交给 Loader 的 Config；undefined = 这个部署里拿不到 schemastery，只有 YAML 配置。 */
export const Config = buildConfig();

/** schema 是否可用（用来在工具描述里如实说明 GUI 表单的可用性）。 */
export const schemaAvailable = Config !== undefined;

/**
 * 判断是不是 schemastery 的 volatile 盒子。
 *
 * 盒子就是只有一个 `get` 方法的对象（实测 `Object.getOwnPropertyNames(box) === ['get']`），
 * 所以鸭子类型足够精确：插件自己的配置值里不会有这种东西。
 */
export function isVolatileBox(value) {
	return value !== null && typeof value === 'object' && typeof value.get === 'function' && Object.getOwnPropertyNames(value).length === 1;
}

/**
 * 把 `apply(ctx, config)` 收到的配置摊平成普通值。
 *
 * 声明了 schema 之后，volatile 字段到手是盒子（`.get()`），普通字段还是普通值。
 * 摊平之后 `resolveSettings` 不必关心这件事。
 */
export function unwrapConfig(value, depth = 0) {
	if (depth > 8) return value;
	if (isVolatileBox(value)) return unwrapConfig(value.get(), depth + 1);
	if (Array.isArray(value)) return value.map((entry) => unwrapConfig(entry, depth + 1));
	if (value !== null && typeof value === 'object') {
		const out = {};
		for (const [key, child] of Object.entries(value)) out[key] = unwrapConfig(child, depth + 1);
		return out;
	}
	return value;
}