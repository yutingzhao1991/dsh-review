/**
 * dsh-review 的浏览器半边：在侧边栏 Plugins → dsh-review 的行/包页面上渲染配置表单。
 *
 * 这是手写的 `__ModuleLoader__` 工厂 bundle（DSH 客户端模块系统的加载格式），
 * 不需要构建工具：externals 只有 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`，
 * 两者都由宿主的模块表提供。
 *
 * 表单本体不自造控件——直接用 DSH 官方那套 `SettingsForm` + `SettingsFormModel` +
 * `SettingsValueField`，因此「暂存 → 保存 → revision 冲突 → 回读」这套逻辑与官方
 * 设置页完全一致，我这里只负责「字段清单」与「值 ↔ 文本」的转换：
 *
 * - 数组（默认评审者、provider 列表）写成逗号分隔的一行；
 * - 布尔写成 true/false（也认 1/0、yes/no、是/否）；
 * - `reviewers` / `modes` 是嵌套结构，用 JSON 文本框；解析失败会让保存按钮变灰并提示。
 */

window.__ModuleLoader__.load({
	id: 'dsh-review',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const react = require('react');
		const P = require('@deepseek-ai/dsh-client-ui-primitives');
		const h = react.createElement;

		/** 字典命名空间（本插件自己拥有）。 */
		const NS = 'dsh-review';
		/** 设置命名空间 = profile 里那一行的 id（`cordis.patch.yml` 的 `- id: review`）。 */
		const ENTRY = 'review';
		/** 这个 bundle 的包名：`plugins.bundle.config` / `plugins.row.config` 的 key 用它拼。 */
		const PKG = 'dsh-review';

		/* ────────────────────────── 字典 ────────────────────────── */

		const zh = {
			title: '代码评审',
			summary: '配置 review 工具的评审者、模式与预算。',
			groupBehavior: '评审行为',
			groupBudget: '预算与超时',
			groupDiscover: '模型发现',
			groupAdvanced: '高级（JSON）',
			defaultReviewers: '默认评审者',
			defaultReviewersHint: '不传 reviewers 时用它们；逗号分隔，例如 codex, qwen。留空表示用全部启用的评审者。',
			defaultMode: '默认评审模式',
			defaultModeHint: '不传 mode 时套用的模式名；留空表示不套模式。',
			language: '输出语言',
			languageHint: 'zh / en / auto（auto 跟随附加指令，没有指令时用中文）。',
			injectPolicy: '把评审策略写进系统提示词',
			injectPolicyHint: 'true 时把模式里 when 的规则告诉智能体；false（默认）完全不做约束。',
			waitMs: '前台等待时长（毫秒）',
			waitMsHint: '超过它就把 job id 交回，由 job_output 收结论；0 = 不等待。',
			hardTimeoutMs: '硬超时上限（毫秒）',
			hardTimeoutMsHint: '整次评审的墙钟上限；0 = 不限制。',
			maxResultChars: '结论字符上限',
			maxResultCharsHint: '回给模型的报告上限，超出按首尾截断并给出完整报告路径。',
			maxDiffChars: 'diff 字符上限',
			maxDiffCharsHint: '喂给需要 diff 的评审者的变更正文上限。',
			maxFileDiffChars: '单文件 diff 上限',
			maxFileDiffCharsHint: '单个文件超出只保留头部并注明。',
			maxUntrackedFileChars: '未跟踪文件上限',
			maxUntrackedFileCharsHint: '每个未跟踪新文件读取正文的上限。',
			maxArgBytes: 'argv 单参数字节上限',
			maxArgBytesHint: '以 argv 收提示词的 CLI 评审者的单参数上限（Linux 约 128 KiB）；超出会被截断并写进报告脚注。',
			discoverEnabled: '自动展开模型',
			discoverEnabledHint: 'true 时把下面 provider 的模型自动纳入评审者；不需要预先在 reviewers 里写一遍。',
			discoverProviders: '要展开的 provider',
			discoverProvidersHint: '逗号分隔；留空表示全部已注册 provider。写了就是「打开发现」。',
			discoverInclude: '模型白名单（glob）',
			discoverIncludeHint: '逗号分隔，例如 qwen*, glm*；留空表示不限。',
			discoverExclude: '模型黑名单（glob）',
			discoverExcludeHint: '逗号分隔，例如 *embedding*；既不会被展开，也不允许按需指名。',
			discoverLabel: '标签模板',
			discoverLabelHint: '支持 {provider} {providerName} {model} {name}。',
			discoverInDefault: '发现的模型进默认集合',
			discoverInDefaultHint: 'false（默认）时它们只是「可用」，要显式指名才会用到。',
			discoverAdHoc: '允许按需指名 provider/model',
			discoverAdHocHint: 'true（默认）时工具参数可以直接写 bailian/kimi-k3 这类不在配置里的模型。',
			reviewersJson: '评审者定义（JSON 数组）',
			reviewersJsonHint: '每个元素形如 {"id":"qwen","kind":"llm","provider":"bailian","model":"qwen3.8-max"}。留空表示清掉这一项。',
			modesJson: '评审模式（JSON 对象）',
			modesJsonHint: '形如 {"deep":{"strength":"deep","reviewers":["codex"],"synthesize":true}}。留空表示清掉这一项。',
			invalidJson: '不是合法 JSON（或类型不对）',
			invalidNumber: '需要一个不小于下限的整数',
			invalidBoolean: '填 true / false',
			invalidChoice: '只能填 zh、en 或 auto',
			overridden: '已覆盖',
			reset: '恢复默认',
			readOnly: '本部署的设置为只读。',
			unavailable: '该插件当前未加载，暂时无法配置。',
			save: '保存',
			saving: '保存中…',
			saveFailed: '本部署没有接受这些值，已保留供你修改。',
		};

		const en = {
			title: 'Code review',
			summary: 'Configure the review tool’s reviewers, modes, and budgets.',
			groupBehavior: 'Review behaviour',
			groupBudget: 'Budgets and timeouts',
			groupDiscover: 'Model discovery',
			groupAdvanced: 'Advanced (JSON)',
			defaultReviewers: 'Default reviewers',
			defaultReviewersHint: 'Used when a call omits reviewers; comma-separated, e.g. codex, qwen. Empty means every enabled reviewer.',
			defaultMode: 'Default review mode',
			defaultModeHint: 'Applied when a call omits mode; empty means no mode.',
			language: 'Output language',
			languageHint: 'zh / en / auto (auto follows the instructions, Chinese when there are none).',
			injectPolicy: 'Write the review policy into the system prompt',
			injectPolicyHint: 'true states each mode’s `when` rule to the agent; false (default) constrains nothing.',
			waitMs: 'Foreground wait (ms)',
			waitMsHint: 'Past it the tool hands back a job id for job_output; 0 = do not wait.',
			hardTimeoutMs: 'Hard timeout (ms)',
			hardTimeoutMsHint: 'Wall-clock ceiling for the whole review; 0 = unlimited.',
			maxResultChars: 'Report character cap',
			maxResultCharsHint: 'Cap on the report returned to the model; longer reports are head/tail truncated with a path to the full file.',
			maxDiffChars: 'Diff character cap',
			maxDiffCharsHint: 'Cap on the diff packet fed to reviewers that need it.',
			maxFileDiffChars: 'Per-file diff cap',
			maxFileDiffCharsHint: 'A larger file keeps its head with a marker.',
			maxUntrackedFileChars: 'Untracked file cap',
			maxUntrackedFileCharsHint: 'Cap on the body read from each untracked new file.',
			maxArgBytes: 'Single-argument byte cap',
			maxArgBytesHint: 'Per-argument cap for CLI reviewers that receive the prompt via argv (Linux allows ~128 KiB); truncation is reported in the footnotes.',
			discoverEnabled: 'Expand models automatically',
			discoverEnabledHint: 'true pulls the providers below into the reviewer set, so you need not list them in reviewers.',
			discoverProviders: 'Providers to expand',
			discoverProvidersHint: 'Comma-separated; empty means every registered provider. Writing it enables discovery.',
			discoverInclude: 'Model allowlist (glob)',
			discoverIncludeHint: 'Comma-separated, e.g. qwen*, glm*; empty means no limit.',
			discoverExclude: 'Model denylist (glob)',
			discoverExcludeHint: 'Comma-separated, e.g. *embedding*; never expanded and refused ad hoc.',
			discoverLabel: 'Label template',
			discoverLabelHint: 'Supports {provider} {providerName} {model} {name}.',
			discoverInDefault: 'Discovered models join the default set',
			discoverInDefaultHint: 'false (default) keeps them available but only used when named.',
			discoverAdHoc: 'Allow naming provider/model ad hoc',
			discoverAdHocHint: 'true (default) lets a tool call name a model that is not in the config, e.g. bailian/kimi-k3.',
			reviewersJson: 'Reviewer definitions (JSON array)',
			reviewersJsonHint: 'Each entry like {"id":"qwen","kind":"llm","provider":"bailian","model":"qwen3.8-max"}. Empty clears the entry.',
			modesJson: 'Review modes (JSON object)',
			modesJsonHint: 'Like {"deep":{"strength":"deep","reviewers":["codex"],"synthesize":true}}. Empty clears the entry.',
			invalidJson: 'Not valid JSON (or the wrong type)',
			invalidNumber: 'Needs an integer at or above the minimum',
			invalidBoolean: 'Enter true / false',
			invalidChoice: 'Enter zh, en, or auto',
			overridden: 'Overridden',
			reset: 'Reset to default',
			readOnly: 'This deployment stores settings read-only.',
			unavailable: 'This plugin is not loaded right now, so it cannot be configured.',
			save: 'Save',
			saving: 'Saving…',
			saveFailed: 'This deployment did not accept these values; they were kept for you to fix.',
		};

		/* ────────────────────────── 字段 ────────────────────────── */
		/* 每个字段：schema 里的路径 + 「值 ↔ 文本」转换 + 文案键。
		   转换规则决定了哪些输入算合法——不合法时保存被拦住，而不是被悄悄丢掉。 */

		/** 数字字段：整数且不低于下限。 */
		function numberField(field, min) {
			const base = P.settingsNumberField(field);
			return {
				...base,
				parse: (text) => {
					const write = base.parse(text);
					if (write?.kind !== 'set') return write;
					const value = write.value;
					return Number.isSafeInteger(value) && value >= min && !Object.is(value, -0) ? write : undefined;
				},
			};
		}

		/** 数组字段：逗号或换行分隔；空 = 清掉这一项（回到默认）。 */
		function listField(field) {
			return {
				field,
				format: (value) => (Array.isArray(value) ? value.join(', ') : ''),
				parse: (text) => {
					const raw = String(text).trim();
					if (raw.length === 0) return { kind: 'clear' };
					const items = raw
						.split(/[,\n]/)
						.map((entry) => entry.trim())
						.filter((entry) => entry.length > 0);
					return items.length > 0 ? { kind: 'set', value: items } : undefined;
				},
			};
		}

		/** 布尔字段：认 true/false、1/0、yes/no、on/off、是/否、开/关。 */
		function boolField(field) {
			const yes = new Set(['true', '1', 'yes', 'on', '是', '开']);
			const no = new Set(['false', '0', 'no', 'off', '否', '关']);
			return {
				field,
				format: (value) => (value === undefined || value === null ? '' : value ? 'true' : 'false'),
				parse: (text) => {
					const raw = String(text).trim().toLowerCase();
					if (raw.length === 0) return { kind: 'clear' };
					if (yes.has(raw)) return { kind: 'set', value: true };
					if (no.has(raw)) return { kind: 'set', value: false };
					return undefined;
				},
			};
		}

		/** 枚举字段。 */
		function choiceField(field, allowed) {
			return {
				field,
				format: (value) => (value === undefined || value === null ? '' : String(value)),
				parse: (text) => {
					const raw = String(text).trim();
					if (raw.length === 0) return { kind: 'clear' };
					return allowed.includes(raw) ? { kind: 'set', value: raw } : undefined;
				},
			};
		}

		/** JSON 字段：reviewers 必须是数组，modes 必须是对象；条目本身由宿主侧的配置归一化校验。 */
		function jsonField(field, kind) {
			return {
				field,
				format: (value) => (value === undefined || value === null ? '' : JSON.stringify(value, null, 2)),
				parse: (text) => {
					const raw = String(text).trim();
					if (raw.length === 0) return { kind: 'clear' };
					let parsed;
					try {
						parsed = JSON.parse(raw);
					} catch {
						return undefined;
					}
					if (kind === 'array' && !Array.isArray(parsed)) return undefined;
					if (kind === 'object' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) return undefined;
					return { kind: 'set', value: parsed };
				},
			};
		}

		/** 表单字段清单：顺序即渲染顺序。 */
		const FIELDS = [
			{ path: 'defaultReviewers', spec: listField('defaultReviewers'), label: 'defaultReviewers', hint: 'defaultReviewersHint', min: 0, group: 'behavior' },
			{ path: 'defaultMode', spec: P.settingsTextField('defaultMode'), label: 'defaultMode', hint: 'defaultModeHint', group: 'behavior' },
			{ path: 'language', spec: choiceField('language', ['zh', 'en', 'auto']), label: 'language', hint: 'languageHint', invalid: 'invalidChoice', group: 'behavior' },
			{ path: 'injectPolicy', spec: boolField('injectPolicy'), label: 'injectPolicy', hint: 'injectPolicyHint', invalid: 'invalidBoolean', group: 'behavior' },
			{ path: 'waitMs', spec: numberField('waitMs', 0), label: 'waitMs', hint: 'waitMsHint', numeric: true, group: 'budget' },
			{ path: 'hardTimeoutMs', spec: numberField('hardTimeoutMs', 0), label: 'hardTimeoutMs', hint: 'hardTimeoutMsHint', numeric: true, group: 'budget' },
			{ path: 'maxResultChars', spec: numberField('maxResultChars', 0), label: 'maxResultChars', hint: 'maxResultCharsHint', numeric: true, group: 'budget' },
			{ path: 'maxDiffChars', spec: numberField('maxDiffChars', 0), label: 'maxDiffChars', hint: 'maxDiffCharsHint', numeric: true, group: 'budget' },
			{ path: 'maxFileDiffChars', spec: numberField('maxFileDiffChars', 0), label: 'maxFileDiffChars', hint: 'maxFileDiffCharsHint', numeric: true, group: 'budget' },
			{ path: 'maxUntrackedFileChars', spec: numberField('maxUntrackedFileChars', 0), label: 'maxUntrackedFileChars', hint: 'maxUntrackedFileCharsHint', numeric: true, group: 'budget' },
			{ path: 'maxArgBytes', spec: numberField('maxArgBytes', 1), label: 'maxArgBytes', hint: 'maxArgBytesHint', numeric: true, group: 'budget' },
			{ path: 'discover.enabled', spec: boolField('discover.enabled'), label: 'discoverEnabled', hint: 'discoverEnabledHint', invalid: 'invalidBoolean', group: 'discover' },
			{ path: 'discover.providers', spec: listField('discover.providers'), label: 'discoverProviders', hint: 'discoverProvidersHint', group: 'discover' },
			{ path: 'discover.include', spec: listField('discover.include'), label: 'discoverInclude', hint: 'discoverIncludeHint', group: 'discover' },
			{ path: 'discover.exclude', spec: listField('discover.exclude'), label: 'discoverExclude', hint: 'discoverExcludeHint', group: 'discover' },
			{ path: 'discover.label', spec: P.settingsTextField('discover.label'), label: 'discoverLabel', hint: 'discoverLabelHint', group: 'discover' },
			{ path: 'discover.inDefault', spec: boolField('discover.inDefault'), label: 'discoverInDefault', hint: 'discoverInDefaultHint', invalid: 'invalidBoolean', group: 'discover' },
			{ path: 'discover.adHoc', spec: boolField('discover.adHoc'), label: 'discoverAdHoc', hint: 'discoverAdHocHint', invalid: 'invalidBoolean', group: 'discover' },
			{ path: 'reviewers', spec: jsonField('reviewers', 'array'), label: 'reviewersJson', hint: 'reviewersJsonHint', invalid: 'invalidJson', group: 'advanced' },
			{ path: 'modes', spec: jsonField('modes', 'object'), label: 'modesJson', hint: 'modesJsonHint', invalid: 'invalidJson', group: 'advanced' },
		];

		const GROUPS = [
			{ key: 'behavior', label: 'groupBehavior' },
			{ key: 'budget', label: 'groupBudget' },
			{ key: 'discover', label: 'groupDiscover' },
			{ key: 'advanced', label: 'groupAdvanced' },
		];

		/** 字段 id：给 label 的 htmlFor 用，稳定且不含路径里的点。 */
		function fieldId(path) {
			return `plugin-config-review-${path.replace(/[^A-Za-z0-9]+/g, '-')}`;
		}

		function formLabels(t) {
			return {
				unavailable: t('unavailable'),
				readOnly: t('readOnly'),
				saveFailed: t('saveFailed'),
				save: t('save'),
				saving: t('saving'),
			};
		}

		/* ────────────────────────── 页面 ────────────────────────── */

		/**
		 * dsh-review 的配置页。
		 *
		 * `props` 由槽位的 inject 提供：`hooks.<name>` 由槽位系统包成 React hook，
		 * 其余（edit / resetField / save / discard）是 SettingsFormModel 的写动作。
		 */
		function ReviewConfigPage(props) {
			const t = props.t;
			const view = props.useReviewConfigForm((snapshot) => snapshot);
			if (props.view === 'summary') return t('summary');
			const disabled = !view.shell.writable || view.shell.saving;
			return h(
				P.SettingsForm,
				{
					labels: formLabels(t),
					state: view.shell,
					onSave: props.save,
					onDiscard: props.discard,
				},
				GROUPS.map((group) =>
					h(
						'section',
						{ key: group.key, className: 'dsh-review-group' },
						h('h4', { className: 'dsh-review-group-title' }, t(group.label)),
						FIELDS.filter((field) => field.group === group.key).map((field) =>
							h(P.SettingsValueField, {
								key: field.path,
								id: fieldId(field.path),
								label: t(field.label),
								hint: t(field.hint),
								invalidLabel: t(field.invalid ?? 'invalidJson'),
								overriddenLabel: t('overridden'),
								resetLabel: t('reset'),
								numeric: field.numeric === true,
								disabled,
								...view.fields[field.path],
								onEdit: (text) => props.edit(field.path, text),
								onReset: () => props.resetField(field.path),
							}),
						),
					),
				),
			);
		}

		/* ────────────────────────── 挂载 ────────────────────────── */

		/** 必需服务（cordis fiber inject）。 */
		const inject = ['slots', 'locale', 'configForms'];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-review: dictionaries');

			// 表单模型：staged 编辑 + 一次原子写入，和官方设置页共用同一套机制。
			const model = new P.SettingsFormModel(
				ctx.configForms.get(ENTRY),
				FIELDS.map((field) => field.spec),
			);
			const store = model.bind(() => ({
				shell: model.shell(),
				fields: Object.fromEntries(FIELDS.map((field) => [field.path, model.field(field.path)])),
			}));
			ctx.effect(() => () => model.dispose(), 'dsh-review: form subscription');

			const actions = model.actions();
			const register = (name, key) =>
				ctx.slots.register(
					{
						name,
						key,
						locale: NS,
						inject: () => ({ hooks: { reviewConfigForm: store }, ...actions }),
					},
					ReviewConfigPage,
				);

			// 两个座位都占：行页（key `包名#行 id`）与包页（key 包名）。
			// 宿主把第三方 bundle 的配置明确放在这两个槽位里，用户从哪条路点进来都能改。
			ctx.effect(
				() =>
					ctx.configForms.whileServed([ENTRY], () =>
						ctx.slots.inject('plugins.row.config', () => register('plugins.row.config', `${PKG}#${ENTRY}`)),
					),
				'dsh-review: row config page',
			);
			ctx.effect(
				() =>
					ctx.configForms.whileServed([ENTRY], () =>
						ctx.slots.inject('plugins.bundle.config', () => register('plugins.bundle.config', PKG)),
					),
				'dsh-review: bundle config page',
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = NS;
		return module.exports;
	},
});