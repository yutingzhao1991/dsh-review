/**
 * dsh-review 的浏览器半边：在侧边栏 Plugins → dsh-review 的行/包页面上渲染配置表单。
 *
 * 这是手写的 `__ModuleLoader__` 工厂 bundle（DSH 客户端模块系统的加载格式），
 * 不需要构建工具：externals 只有 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`，
 * 两者都由宿主的静态模块表提供。
 *
 * **为什么是一个文件**：宿主按 `<id>/client.js` 一次取走整个客户端半边；拆成多文件要用
 * 模块表的分包机制（`require.async`），对一个配置页不值得，所以这里是一份自包含的工厂。
 * 内部按「字典 → 纯逻辑 → 字段 spec → 控件 → 编辑器 → 页面 → 挂载」分节，顺着读即可。
 *
 * 表单本体不自造控件——直接用 DSH 官方那套 `SettingsForm` + `SettingsFormModel`，
 * 「暂存 → 保存 → revision 冲突 → 回读」与官方设置页完全一致。
 *
 * 输入方式优先「能选就别让人填」：
 *
 * - 开关用 `Switch`；三选一用 `SegmentedControl`；多选/长列表用 `Menu` 下拉或 `Checkbox` 组；
 * - provider / model 来自宿主实时目录（`remote.session.modelCatalog()`），不让人背模型名；
 * - `reviewers` 与 `modes` 是结构化编辑器（增删行 + 逐字段选择），写回时仍然落到同一份
 *   JSON 值上，所以存储格式与 YAML 完全一致；想手写 JSON 也有折叠的兜底入口。
 */

window.__ModuleLoader__.load({
	id: 'dsh-review',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const react = require('react');
		const P = require('@deepseek-ai/dsh-client-ui-primitives');
		const h = react.createElement;
		const useState = react.useState;

		/** 字典命名空间（本插件自己拥有）。 */
		const NS = 'dsh-review';
		/** 设置命名空间 = profile 里那一行的 id（`cordis.patch.yml` 的 `- id: review`）。 */
		const ENTRY = 'review';
		/** 这个 bundle 的包名：`plugins.bundle.config` / `plugins.row.config` 的 key 用它拼。 */
		const PKG = 'dsh-review';

		/** 自动保存的防抖时长（测试可改小，避免等 500ms）。 */
		const AUTO = { delayMs: 500 };

		const KINDS = ['cli', 'subagent'];
		const CLI_PRESETS = ['codex', 'claude', 'gemini', 'opencode', 'cursor', 'custom'];
		const STRENGTHS = ['light', 'standard', 'deep'];

		/* ────────────────────────── 字典 ────────────────────────── */

		const zh = {
			summary: '先勾选要用的评审者，再按需调整高级配置。',
			groupActive: '启用的评审者',
			groupReviewers: '评审者定义',
			groupAdvanced: '高级配置',
			advancedHint: '模式、语言与预算。默认收起，需要时再展开。',
			expandSection: '展开',
			collapseSection: '收起',
			activeHint: '只列出「评审者定义」里启用的那些。勾上的会被 review 工具默认使用；也可以在调用时用 reviewers 参数临时指定别的。',
			activeEmpty: '还没有评审者定义，先到下面添加一个。',
			activeNoneSelected: '一个都没勾 = 不启用任何评审者：这时调用 review 会直接报错，要求显式指定 reviewers。',
			activeDisabledNote: '另有 {count} 个评审者被「启用」开关关掉了，不在这里列出。',
			activeUnknownNote: '以下 id 在配置里被选中，但已不在评审者定义里（可能是改过 id）：',
			activeUnknownMeta: 'not in the reviewer definitions',
			defaultModeNone: 'No mode',
			activeUnknownMeta: '不在评审者定义里',
			defaultModeNone: '不套模式',
			defaultReviewers: '启用的评审者',
			defaultReviewersHint: '勾上的会被默认使用。',
			groupBehavior: '评审行为',
			groupModes: '评审模式',
			groupBudget: '预算与超时',
			defaultMode: '默认评审模式',
			defaultModeHint: '不传 mode 时套用的模式。',
			language: '输出语言',
			languageHint: 'auto 跟随附加指令，没有指令时用中文。',
			injectPolicy: '把评审策略写进系统提示词',
			injectPolicyHint: '打开后会把模式里「强制评审策略」告诉智能体；默认关闭，完全不做约束。',
			addReviewer: '添加评审者',
			remove: '删除',
			reviewerId: 'id（工具参数里引用它）',
			reviewerKind: '类型',
			reviewerKindCli: 'CLI 智能体',
			reviewerKindSubagent: '子智能体',
			reviewerKindRemoved: '这个类型已移除（原：',
			reviewerPreset: 'CLI 预设',
			reviewerExecutable: '可执行文件',
			catalogLoading: '正在读取可用模型…',
			catalogFailed: '模型目录读取失败，可以自己填 provider 与模型名。',
			catalogRetry: '重新读取',
			modelCatalogEmpty: 'DSH 里还没有可用的模型 provider。可以直接填写 provider 与模型名。',
			providerMissing: '（未选 provider）',
			modelMissing: '（未选模型）',
			reviewerModel: '模型',
			reviewerProvider: 'provider',
			reviewerLabel: '显示名（可选）',
			reviewerEnabled: '启用',
			reviewerServiceProvider: '子智能体服务',
			reviewerServiceProviderHint: '默认 spawn，只有换了 subagent 服务实现时才需要改（一般不用动）。',
			reviewerAgentModel: '子智能体的模型',
			reviewerModelHint: '来自 DSH 当前可用的 provider 与模型；选中后两个字段一起更新。',
			chooseModel: '选择模型',
			modelNotInCatalog: '当前配置（不在模型目录里）',
			noReviewers: '还没有评审者。先添加一个，或用下面的原始 JSON 直接写。',
			addMode: '添加模式',
			modeName: '模式名（工具参数 mode 用它）',
			modeReviewers: '用哪些评审者',
			modeReviewersHint: '一个都不勾 = 用上面选定的默认集合。',
			modeWhen: '强制评审策略',
			modeWhenHint: '只在「把评审策略写进系统提示词」打开时生效。',
			modeWhenOff: '不设',
			modeWhenAlways: '所有改动都必须评审',
			modeWhenComplex: '只要求复杂改动',
			modeWhenNever: '不强制',
			modeMinLines: '复杂改动的行数阈值（可选）',
			modePrompt: '模式的附加提示词（可选）',
			modeDescription: '说明，展示在工具描述里（可选）',
			noModes: '还没有模式。没有模式时插件不追加任何强度或提示词约束。',
			waitMs: '前台等待时长（毫秒）',
			waitMsHint: '超过它就把 job id 交回，由 job_output 收结论；0 = 不等待。',
			hardTimeoutMs: '硬超时上限（毫秒）',
			hardTimeoutMsHint: '兜底墙钟上限；0 = 不限制（默认），什么时候终止由调用方自己判断。',
			maxResultChars: '结论字符上限',
			maxResultCharsHint: '回给模型的报告上限，超出按首尾截断并给出完整报告路径。',
			maxDiffChars: 'diff 字符上限',
			maxDiffCharsHint: '喂给需要 diff 的评审者的变更正文上限。',
			maxFileDiffChars: '单文件 diff 上限',
			maxFileDiffCharsHint: '单个文件超出只保留头部并注明。',
			maxUntrackedFileChars: '未跟踪文件上限',
			maxUntrackedFileCharsHint: '每个未跟踪新文件读取正文的上限。',
			maxArgBytes: 'argv 单参数字节上限',
			maxArgBytesHint: '以 argv 收提示词的 CLI 评审者的单参数上限（Linux 约 128 KiB）。',
			autoIdle: '改动会自动保存',
			autoPending: '有改动待保存…',
			autoSaving: '正在保存…',
			autoSaved: '已自动保存',
			autoFailed: '保存失败（配置可能被别处改过），已重试一次；也可以点「立即保存」再试',
			autoBlocked: '有取值不合法，修正后会自动保存',
			saveNow: '立即保存',
			showJson: '显示原始 JSON',
			hideJson: '收起原始 JSON',
			jsonHint: '直接编辑存储值；保存时会校验（评审者必须是数组且每行有 id，模式必须是对象）。',
			invalidReviewer: '每个评审者都要有 id，kind 只能是 cli / subagent',
			invalidMode: '每个模式都要有名字，strength 只能是 light / standard / deep',
			invalidNumber: '需要一个不小于下限的整数',
			invalidChoice: '取值不合法',
			overridden: '已覆盖',
			reset: '恢复默认',
			readOnly: '本部署的设置为只读。',
			unavailable: '该插件当前未加载，暂时无法配置。',
			saving: '保存中…',
			saveFailed: '本部署没有接受这些值，已保留你的修改。',
		};

		const en = {
			summary: 'Pick the reviewers you want first, then adjust advanced settings as needed.',
			groupActive: 'Enabled reviewers',
			groupReviewers: 'Reviewer definitions',
			groupAdvanced: 'Advanced settings',
			advancedHint: 'Modes, language, and budgets. Collapsed by default.',
			expandSection: 'Expand',
			collapseSection: 'Collapse',
			activeHint: 'Only reviewers that are enabled below are listed. Checked ones are used by default; a call may still name others with its reviewers argument.',
			activeEmpty: 'No reviewer definitions yet — add one below.',
			activeNoneSelected: 'Nothing checked means no reviewers are enabled: calling review would fail and ask for explicit reviewers.',
			activeDisabledNote: '{count} more reviewer(s) are turned off by their “enabled” switch and are not listed here.',
			activeUnknownNote: 'These ids are selected in the config but no longer defined (an id may have changed):',
			activeUnknownMeta: 'not in the reviewer definitions',
			defaultModeNone: 'No mode',
			defaultReviewers: 'Enabled reviewers',
			defaultReviewersHint: 'Checked ones are used by default.',
			groupBehavior: 'Review behaviour',
			groupModes: 'Review modes',
			groupBudget: 'Budgets and timeouts',
			defaultMode: 'Default review mode',
			defaultModeHint: 'Applied when a call omits mode.',
			language: 'Output language',
			languageHint: 'auto follows the instructions, Chinese when there are none.',
			injectPolicy: 'Write the review policy into the system prompt',
			injectPolicyHint: 'States each mode’s mandatory-review policy to the agent; off by default, which constrains nothing.',
			addReviewer: 'Add reviewer',
			remove: 'Remove',
			reviewerId: 'id (referenced by tool arguments)',
			reviewerKind: 'Kind',
			reviewerKindCli: 'CLI agent',
			reviewerKindSubagent: 'Subagent',
			reviewerKindRemoved: 'This kind was removed (was: ',
			reviewerPreset: 'CLI preset',
			reviewerExecutable: 'Executable',
			catalogLoading: 'Loading available models…',
			catalogFailed: 'Could not read the model catalog; type the provider and model yourself.',
			catalogRetry: 'Reload',
			modelCatalogEmpty: 'No model provider is available in DSH yet. You can type a provider and model below.',
			providerMissing: '(no provider selected)',
			modelMissing: '(no model selected)',
			reviewerModel: 'Model',
			reviewerProvider: 'Provider',
			reviewerLabel: 'Display name (optional)',
			reviewerEnabled: 'Enabled',
			reviewerServiceProvider: 'Subagent service',
			reviewerServiceProviderHint: 'Defaults to spawn; change it only when another subagent service is installed.',
			reviewerAgentModel: 'Subagent model',
			reviewerModelHint: 'Providers and models currently registered in DSH; picking one updates both fields.',
			chooseModel: 'Choose a model',
			modelNotInCatalog: 'Current setting (not in the model catalog)',
			noReviewers: 'No reviewers yet. Add one, or write them in the raw JSON below.',
			addMode: 'Add mode',
			modeName: 'Name (referenced by the tool’s mode argument)',
			modeReviewers: 'Reviewers to use',
			modeReviewersHint: 'None selected means the default set chosen above.',
			modeWhen: 'Mandatory-review policy',
			modeWhenHint: 'Only takes effect while “write the review policy into the system prompt” is on.',
			modeWhenOff: 'Unset',
			modeWhenAlways: 'Every change must be reviewed',
			modeWhenComplex: 'Only complex changes',
			modeWhenNever: 'Not required',
			modeMinLines: 'Complexity threshold in lines (optional)',
			modePrompt: 'Extra prompt for this mode (optional)',
			modeDescription: 'Description shown in the tool description (optional)',
			noModes: 'No modes yet. With none, the plugin adds no strength or prompt constraints.',
			waitMs: 'Foreground wait (ms)',
			waitMsHint: 'Past it the tool hands back a job id for job_output; 0 = do not wait.',
			hardTimeoutMs: 'Hard timeout (ms)',
			hardTimeoutMsHint: 'Fallback wall-clock ceiling; 0 = unlimited (the default) — the caller decides when to stop it.',
			maxResultChars: 'Report character cap',
			maxResultCharsHint: 'Cap on the report returned to the model; longer reports are head/tail truncated with a path to the full file.',
			maxDiffChars: 'Diff character cap',
			maxDiffCharsHint: 'Cap on the diff packet fed to reviewers that need it.',
			maxFileDiffChars: 'Per-file diff cap',
			maxFileDiffCharsHint: 'A larger file keeps its head with a marker.',
			maxUntrackedFileChars: 'Untracked file cap',
			maxUntrackedFileCharsHint: 'Cap on the body read from each untracked new file.',
			maxArgBytes: 'Single-argument byte cap',
			maxArgBytesHint: 'Per-argument cap for CLI reviewers that receive the prompt via argv (Linux allows ~128 KiB).',
			autoIdle: 'Changes are saved automatically',
			autoPending: 'Unsaved changes…',
			autoSaving: 'Saving…',
			autoSaved: 'Saved automatically',
			autoFailed: 'Save failed (the config may have changed elsewhere); retried once — “Save now” tries again',
			autoBlocked: 'A value is invalid; it will save once corrected',
			saveNow: 'Save now',
			showJson: 'Show raw JSON',
			hideJson: 'Hide raw JSON',
			jsonHint: 'Edits the stored value directly; saving validates it (reviewers must be an array of objects with ids, modes an object).',
			invalidReviewer: 'Every reviewer needs an id, and kind must be cli / subagent',
			invalidMode: 'Every mode needs a name, and strength must be light / standard / deep',
			invalidNumber: 'Needs an integer at or above the minimum',
			invalidChoice: 'Not an accepted value',
			overridden: 'Overridden',
			reset: 'Reset to default',
			readOnly: 'This deployment stores settings read-only.',
			unavailable: 'This plugin is not loaded right now, so it cannot be configured.',
			saving: 'Saving…',
			saveFailed: 'This deployment did not accept these values; your edits were kept.',
		};

		/* ────────────────────────── 纯逻辑（自测直接覆盖） ────────────────────────── */

		/** 逗号/换行分隔的列表文本 → 数组（去空、去空白）。 */
		function splitList(text) {
			return String(text ?? '')
				.split(/[,\n]/)
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0);
		}

		/** 宽松 JSON 解析：失败给兜底值，绝不抛。 */
		function parseJson(text, fallback) {
			const raw = String(text ?? '').trim();
			if (raw.length === 0) return fallback;
			try {
				const parsed = JSON.parse(raw);
				return parsed ?? fallback;
			} catch {
				return fallback;
			}
		}

		/** `reviewers` 文本 → 行数组（只接受对象元素）。 */
		function reviewerRows(text) {
			const parsed = parseJson(text, []);
			return Array.isArray(parsed) ? parsed.filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row)) : [];
		}

		/** 行数组 → `reviewers` 文本；空数组写成空串（= 清除这一项）。 */
		function serializeReviewers(rows) {
			return rows.length === 0 ? '' : JSON.stringify(rows, null, 2);
		}

		/** `modes` 文本 → `[{name, body}]`。 */
		function modeRows(text) {
			const parsed = parseJson(text, {});
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
			return Object.entries(parsed).map(([name, body]) => ({ name, body: body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {} }));
		}

		/** 行数组 → `modes` 文本。 */
		function serializeModes(rows) {
			if (rows.length === 0) return '';
			const out = {};
			for (const row of rows) out[row.name] = row.body;
			return JSON.stringify(out, null, 2);
		}

		/** 宿主模型目录 → `[{id, name, models:[{id,name}]}]`；形状不对就当空。 */
		function catalogGroups(catalog) {
			const groups = catalog?.groups;
			if (!Array.isArray(groups)) return [];
			return groups
				.filter((group) => group !== null && typeof group === 'object' && typeof group.id === 'string')
				.map((group) => ({
					id: group.id,
					name: typeof group.name === 'string' && group.name.length > 0 ? group.name : group.id,
					models: Array.isArray(group.models) ? group.models.filter((model) => model !== null && typeof model === 'object' && typeof model.id === 'string') : [],
				}));
		}

		/** 一行评审者「指向什么」的完整描述（tooltip 用，可能很长）。 */
		function reviewerTargetFull(row) {
			if ((row.kind ?? 'cli') === 'subagent') {
				// 真正决定跑什么的是 agentProvider/agentModel；`provider` 只是 subagent 服务实现
				// （默认 spawn），把它放进摘要只会让人以为模型来自 spawn。
				const provider = typeof row.agentProvider === 'string' ? row.agentProvider.trim() : '';
				const model = typeof row.agentModel === 'string' ? row.agentModel.trim() : '';
				return [provider, model].filter((part) => part.length > 0).join('/');
			}
			return row.executable ?? row.preset ?? 'cli';
		}

		/**
		 * 目录 → 扁平的「provider + 模型」路由。
		 *
		 * 合并选择器要同时展示 provider 分组与模型名，所以先摊平成一条条路由；
		 * 选中时再把 `provider` / `model` 一次写回两个字段。
		 */
		function modelRoutes(groups) {
			const routes = [];
			for (const group of Array.isArray(groups) ? groups : []) {
				for (const model of Array.isArray(group.models) ? group.models : []) {
					routes.push({
						provider: group.id,
						providerName: group.name,
						model: model.id,
						modelName: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
					});
				}
			}
			return routes;
		}

		/** 找到某个 provider/model 在目录里的那一条；找不到返回 undefined。 */
		function findModelRoute(groups, provider, model) {
			const wantedProvider = typeof provider === 'string' ? provider : '';
			const wantedModel = typeof model === 'string' ? model : '';
			return modelRoutes(groups).find((route) => route.provider === wantedProvider && route.model === wantedModel);
		}

		/**
		 * 当前行在合并选择器里该显示什么。
		 *
		 * 目录里找不到（provider 还没注册、模型已下线、或老配置手写的名字）时也要保留当前值，
		 * 绝不能显示成「未选」——那会让人以为配置丢了。
		 */
		function currentModelRoute(groups, provider, model) {
			const wantedProvider = typeof provider === 'string' ? provider.trim() : '';
			const wantedModel = typeof model === 'string' ? model.trim() : '';
			if (wantedProvider.length === 0 && wantedModel.length === 0) return undefined;
			const found = findModelRoute(groups, wantedProvider, wantedModel);
			if (found !== undefined) return found;
			// provider 本身还在目录里时沿用它的展示名；只有 provider 也不认识才退回 id。
			const group = Array.isArray(groups) ? groups.find((entry) => entry.id === wantedProvider) : undefined;
			return {
				provider: wantedProvider,
				providerName: group?.name ?? wantedProvider,
				model: wantedModel,
				modelName: wantedModel,
				missing: true,
			};
		}

		/**
		 * 顶部列表里的短摘要：CLI 只留可执行文件名。
		 *
		 * 直接显示 `executable` 的绝对路径会把一行撑满、还把开关和名字挤到左边——
		 * 列表要能一眼扫过去，细节交给 tooltip。
		 */
		function reviewerTarget(row) {
			if ((row.kind ?? 'cli') === 'subagent') return reviewerTargetFull(row);
			const raw = reviewerTargetFull(row);
			return raw.split('/').filter((part) => part.length > 0).pop() ?? raw;
		}

		/**
		 * 顶部「启用的评审者」列表：从定义里挑出可选项，并保留「配置里选中但已不在定义里」的 id，
		 * 免得用户改个 id 就静默丢掉了选择。
		 */
		function reviewerChoices(reviewersText, selectedText) {
			const selected = splitList(selectedText);
			const rows = reviewerRows(reviewersText);
			const usable = rows.filter((row) => row.enabled !== false && typeof row.id === 'string' && row.id.trim().length > 0);
			const choices = usable.map((row) => ({
				id: row.id,
				label: typeof row.label === 'string' && row.label.trim().length > 0 ? row.label : row.id,
				kind: row.kind ?? 'cli',
				target: reviewerTarget(row),
				title: reviewerTargetFull(row),
				checked: selected.includes(row.id),
			}));
			const unknown = selected
				.filter((id) => !choices.some((choice) => choice.id === id))
				.map((id) => ({ id, label: '', kind: 'unknown', target: '', title: '', checked: true }));
			return {
				choices,
				unknown,
				disabledCount: rows.filter((row) => row.enabled === false).length,
				selectedCount: choices.filter((choice) => choice.checked).length + unknown.length,
			};
		}

		/** 勾选/取消一项 → 新的逗号分隔文本（空列表写成空串 = 清除这一项）。 */
		function toggleSelection(selectedText, id, next) {
			const list = splitList(selectedText);
			const updated = next ? (list.includes(id) ? list : [...list, id]) : list.filter((value) => value !== id);
			return updated.join(', ');
		}

		/** CLI 预设 → 默认可执行文件名。 */
		function presetExecutable(preset) {
			return preset === 'cursor' ? 'cursor-agent' : preset;
		}

		/**
		 * 新增评审者行：优先给出「能直接跑」的初值。
		 *
		 * 有模型目录时给**子智能体**并指明 provider/模型（这是仅剩的「用 DSH 里配好的模型」的方式）；
		 * 拿不到目录就退回 CLI 预设。
		 */
		function newReviewerRow(index, groups) {
			const provider = groups?.[0];
			const model = provider?.models?.[0];
			if (provider !== undefined && model !== undefined) {
				return { id: `reviewer-${index}`, kind: 'subagent', provider: 'spawn', agentProvider: provider.id, agentModel: model.id };
			}
			return { id: `reviewer-${index}`, kind: 'cli', preset: 'codex', executable: 'codex' };
		}

		/* ────────────────────────── 字段 spec（文本 ↔ 值） ────────────────────────── */

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

		/** 列表字段：逗号或换行分隔；空 = 清掉这一项（回到默认）。 */
		function listField(field) {
			return {
				field,
				format: (value) => (Array.isArray(value) ? value.join(', ') : ''),
				parse: (text) => {
					const items = splitList(text);
					return items.length > 0 ? { kind: 'set', value: items } : { kind: 'clear' };
				},
			};
		}

		/** 布尔字段：值仍然是 true/false 文本，所以 Switch 也走同一个 spec。 */
		function boolField(field) {
			return {
				field,
				format: (value) => (value === undefined || value === null ? '' : value ? 'true' : 'false'),
				parse: (text) => {
					const raw = String(text).trim().toLowerCase();
					if (raw.length === 0) return { kind: 'clear' };
					if (['true', '1', 'yes', 'on', '是', '开'].includes(raw)) return { kind: 'set', value: true };
					if (['false', '0', 'no', 'off', '否', '关'].includes(raw)) return { kind: 'set', value: false };
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
					if (allowed.length === 0) return { kind: 'set', value: raw };
					return allowed.includes(raw) ? { kind: 'set', value: raw } : undefined;
				},
			};
		}

		/** 评审者数组：类型对 + 每行 id/kind 合法，否则拦住保存。 */
		function reviewersField(field) {
			return {
				field,
				format: (value) => (value === undefined || value === null || (Array.isArray(value) && value.length === 0) ? '' : JSON.stringify(value, null, 2)),
				parse: (text) => {
					const raw = String(text).trim();
					if (raw.length === 0) return { kind: 'clear' };
					let parsed;
					try {
						parsed = JSON.parse(raw);
					} catch {
						return undefined;
					}
					if (!Array.isArray(parsed)) return undefined;
					// 只硬校验「是对象且有 id」。kind 不在这里卡死：老配置可能留着已移除的
					// llm 行，如果这里判非法，整张设置表都会变 invalid 而**什么都存不下去**
					// （form 级 invalid → 保存被拦）。改成原样带过：行内会标出「类型已移除」，
					// 宿主侧也会给出告警，用户看得见、改得动。
					const ok = parsed.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row) && typeof row.id === 'string' && row.id.trim().length > 0);
					return ok ? { kind: 'set', value: parsed } : undefined;
				},
			};
		}

		/** 模式对象：类型对 + 每个模式名非空、strength 合法。 */
		function modesField(field) {
			return {
				field,
				format: (value) => (value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) ? '' : JSON.stringify(value, null, 2)),
				parse: (text) => {
					const raw = String(text).trim();
					if (raw.length === 0) return { kind: 'clear' };
					let parsed;
					try {
						parsed = JSON.parse(raw);
					} catch {
						return undefined;
					}
					if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
					const ok = Object.entries(parsed).every(
						([name, body]) => name.trim().length > 0 && body !== null && typeof body === 'object' && !Array.isArray(body) && (body.strength === undefined || STRENGTHS.includes(body.strength)),
					);
					return ok ? { kind: 'set', value: parsed } : undefined;
				},
			};
		}

		/** 字段清单：顺序即渲染顺序；`reviewers`/`modes` 由结构化编辑器接管，但仍在这里注册 spec。 */
		const FIELDS = [
			// 每个字段自带文案键：以前另有一张 path → [label, hint] 的平行表，两处要对齐、
			// 静态读代码也看不出哪个字段用了哪条文案。
			{ path: 'defaultReviewers', spec: listField('defaultReviewers'), control: 'active', section: 'active', group: 'active', label: 'defaultReviewers', hint: 'defaultReviewersHint' },
			{ path: 'reviewers', spec: reviewersField('reviewers'), control: 'reviewers', section: 'reviewers', group: 'reviewers', label: 'groupReviewers' },
			{ path: 'language', spec: choiceField('language', ['zh', 'en', 'auto']), control: 'segmented', section: 'advanced', group: 'behavior', label: 'language', hint: 'languageHint' },
			{ path: 'injectPolicy', spec: boolField('injectPolicy'), control: 'switch', section: 'advanced', group: 'behavior', label: 'injectPolicy', hint: 'injectPolicyHint' },
			{ path: 'defaultMode', spec: choiceField('defaultMode', []), control: 'mode', section: 'advanced', group: 'behavior', label: 'defaultMode', hint: 'defaultModeHint' },
			{ path: 'modes', spec: modesField('modes'), control: 'modes', section: 'advanced', group: 'modes', label: 'groupModes' },
			{ path: 'waitMs', spec: numberField('waitMs', 0), control: 'number', numeric: true, section: 'advanced', group: 'budget', label: 'waitMs', hint: 'waitMsHint' },
			{ path: 'hardTimeoutMs', spec: numberField('hardTimeoutMs', 0), control: 'number', numeric: true, section: 'advanced', group: 'budget', label: 'hardTimeoutMs', hint: 'hardTimeoutMsHint' },
			{ path: 'maxResultChars', spec: numberField('maxResultChars', 0), control: 'number', numeric: true, section: 'advanced', group: 'budget', label: 'maxResultChars', hint: 'maxResultCharsHint' },
			{ path: 'maxDiffChars', spec: numberField('maxDiffChars', 0), control: 'number', numeric: true, section: 'advanced', group: 'budget', label: 'maxDiffChars', hint: 'maxDiffCharsHint' },
			{ path: 'maxFileDiffChars', spec: numberField('maxFileDiffChars', 0), control: 'number', numeric: true, section: 'advanced', group: 'budget', label: 'maxFileDiffChars', hint: 'maxFileDiffCharsHint' },
			{ path: 'maxUntrackedFileChars', spec: numberField('maxUntrackedFileChars', 0), control: 'number', numeric: true, section: 'advanced', group: 'budget', label: 'maxUntrackedFileChars', hint: 'maxUntrackedFileCharsHint' },
			{ path: 'maxArgBytes', spec: numberField('maxArgBytes', 1), control: 'number', numeric: true, section: 'advanced', group: 'budget', label: 'maxArgBytes', hint: 'maxArgBytesHint' },
		];

		/** 「高级配置」里的子分组顺序。 */
		const ADVANCED_GROUPS = [
			{ key: 'behavior', label: 'groupBehavior' },
			{ key: 'modes', label: 'groupModes' },
			{ key: 'budget', label: 'groupBudget' },
		];

		/** 字段 id：稳定且不含路径里的点，给 htmlFor 用。 */
		function fieldId(path) {
			return `plugin-config-review-${path.replace(/[^A-Za-z0-9]+/g, '-')}`;
		}

		function formLabels(t) {
			return {
				unavailable: t('unavailable'),
				readOnly: t('readOnly'),
				saveFailed: t('saveFailed'),
				// 自动保存之后，这个按钮是「立刻落盘 / 重试」的兜底入口。
				save: t('saveNow'),
				saving: t('saving'),
			};
		}

		/** 自动保存状态行：贴在保存按钮上方，让人知道改动已经写下去了。 */
		function AutoSaveStatus(props) {
			const t = props.t;
			const status = props.status ?? 'idle';
			const text = {
				idle: t('autoIdle'),
				pending: t('autoPending'),
				saving: t('autoSaving'),
				saved: t('autoSaved'),
				failed: t('autoFailed'),
				blocked: t('autoBlocked'),
			}[status] ?? t('autoIdle');
			return h(
				'p',
				{ className: 'dsh-review-autosave', 'data-state': status, role: 'status' },
				h('span', { className: 'dsh-review-autosave-dot', 'aria-hidden': 'true' }),
				h('span', null, text),
			);
		}

		/* ────────────────────────── 通用控件 ────────────────────────── */

		/** 字段外壳：标签 + 覆盖标记 + 重置 + 提示 + 无效提示。 */
		function FieldShell(props) {
			return h(
				'div',
				{ className: 'dsh-review-field' },
				h(
					'div',
					{ className: 'dsh-review-label-row' },
					props.label.length > 0 ? h('label', { className: 'dsh-review-label', htmlFor: props.id }, props.label) : null,
					props.overridden ? h('span', { className: 'dsh-review-badge' }, props.overriddenLabel) : null,
					props.overridden && props.onReset ? h(P.Button, { variant: 'ghost', size: 'sm', disabled: props.disabled, onClick: props.onReset }, props.resetLabel) : null,
				),
				props.children,
				props.hint ? h('p', { className: 'dsh-review-hint' }, props.hint) : null,
				props.invalid ? h('p', { className: 'dsh-review-invalid' }, props.invalidLabel) : null,
			);
		}

		/** 单选下拉：`Menu` 挂在自绘按钮上，选项多少都不怕。 */
		function Dropdown(props) {
			const [open, setOpen] = useState(false);
			const options = props.options.length > 0 ? props.options : [{ value: '', label: props.placeholder ?? '—' }];
			const current = options.find((option) => option.value === props.value);
			return h(P.Menu, {
				open,
				anchor: h(
					P.Button,
					{
						id: props.id,
						variant: 'outline',
						size: 'sm',
						disabled: props.disabled,
						'aria-haspopup': 'menu',
						'aria-expanded': open,
						onClick: () => setOpen(!open),
					},
					current?.label ?? props.value ?? props.placeholder ?? '',
				),
				items: options.map((option) => ({ id: option.value, label: option.label })),
				selectedId: props.value,
				selection: 'check',
				portal: true,
				side: 'bottom',
				align: 'start',
				onSelect: (value) => {
					props.onChange(value);
					setOpen(false);
				},
				onClose: () => setOpen(false),
			});
		}

		/** 多选：选项少用 Checkbox 组，选项多（>6）换成下拉里的勾选列表。 */
		function MultiSelect(props) {
			const [open, setOpen] = useState(false);
			if (props.options.length > 6) {
				const summary = props.values.length === 0 ? props.emptyLabel : props.values.join('、');
				return h(P.Menu, {
					open,
					anchor: h(P.Button, { id: props.id, variant: 'outline', size: 'sm', disabled: props.disabled, onClick: () => setOpen(!open) }, summary),
					items: props.options.map((option) => ({ id: option.value, label: props.values.includes(option.value) ? `✓ ${option.label}` : option.label })),
					onSelect: (value) => props.onChange(props.values.includes(value) ? props.values.filter((entry) => entry !== value) : [...props.values, value]),
					onClose: () => setOpen(false),
					portal: true,
					side: 'bottom',
					align: 'start',
				});
			}
			return h(
				'div',
				{ className: 'dsh-review-choices', id: props.id },
				props.options.map((option) =>
					h(P.Checkbox, {
						key: option.value,
						checked: props.values.includes(option.value),
						label: option.label,
						disabled: props.disabled,
						onChange: (next) => props.onChange(next ? [...props.values, option.value] : props.values.filter((entry) => entry !== option.value)),
					}),
				),
			);
		}

		/* ────────────────────────── 评审者 / 模式编辑器 ────────────────────────── */

		/**
		 * 模型选择器：把「子智能体的 provider」和「模型」合成一个入口。
		 *
		 * 交互对齐 DSH 自己的模型选择：按 provider 分组列出模型，选中一项就同时写回
		 * `agentProvider` 与 `agentModel`，不用先选 provider 再等模型列表刷新。
		 *
		 * 目录不可用（或一个 provider 都没注册）时退回两个输入框——这条路是给
		 * 「目录读取失败 / 老配置手写模型名」留的，不能让人卡在空下拉里。
		 */
		function ModelPicker(props) {
			const [open, setOpen] = useState(false);
			const { t, groups, status, disabled } = props;
			const route = currentModelRoute(groups, props.provider, props.model);

			const manual = (hintKey) =>
				h(
					'div',
					{ className: 'dsh-review-model-fallback' },
					h(
						'div',
						{ className: 'dsh-review-model-fallback-row' },
						h(P.Input, {
							value: props.provider ?? '',
							placeholder: t('reviewerProvider'),
							disabled,
							onChange: (event) => props.onChange({ agentProvider: event.target.value }),
						}),
						h(P.Input, {
							value: props.model ?? '',
							placeholder: t('reviewerModel'),
							disabled,
							onChange: (event) => props.onChange({ agentModel: event.target.value }),
						}),
					),
					h('p', { className: 'dsh-review-hint' }, t(hintKey)),
					status === 'error' && typeof props.onRetry === 'function'
						? h(P.Button, { variant: 'ghost', size: 'sm', disabled, onClick: props.onRetry }, t('catalogRetry'))
						: null,
				);

			// 只有真的挂着模型的分组才值得展开；全是空 provider 时直接给手填入口。
			const usableGroups = groups.filter((group) => Array.isArray(group.models) && group.models.length > 0);
			if (usableGroups.length === 0) {
				return manual(status === 'loading' || status === 'idle' ? 'catalogLoading' : status === 'error' ? 'catalogFailed' : 'modelCatalogEmpty');
			}

			const selectedProvider = route?.provider ?? '';
			const selectedModel = route?.model ?? '';
			const option = (choice, extra = {}) => {
				const selected = choice.provider === selectedProvider && choice.model === selectedModel;
				return h(
					'button',
					{
						key: `${choice.provider}/${choice.model}`,
						type: 'button',
						role: 'menuitemradio',
						'aria-checked': selected ? 'true' : 'false',
						className: `dsh-review-model-option${selected ? ' is-selected' : ''}`,
						title: `${choice.providerName || choice.provider} / ${choice.modelName || choice.model}`,
						disabled: choice.disabled === true,
						...extra,
						onClick: () => {
							if (choice.disabled === true) return;
							props.onChange({ agentProvider: choice.provider, agentModel: choice.model });
							setOpen(false);
						},
					},
					h(
						'span',
						{ className: 'dsh-review-model-option-copy' },
						h('span', { className: 'dsh-review-model-option-name' }, choice.modelName || choice.model || t('modelMissing')),
						choice.modelName !== choice.model ? h('span', { className: 'dsh-review-model-option-id' }, choice.model) : null,
					),
					h('span', { className: 'dsh-review-model-check', 'aria-hidden': 'true' }, selected ? '✓' : ''),
				);
			};

			const currentLabel = route === undefined ? t('chooseModel') : route.modelName || t('modelMissing');
			const currentProvider = route === undefined ? '' : route.providerName || route.provider || t('providerMissing');
			return h(P.Menu, {
				open,
				anchor: h(
					P.Button,
					{
						id: props.id,
						variant: 'outline',
						size: 'sm',
						disabled,
						'aria-haspopup': 'menu',
						'aria-expanded': open,
						title: route === undefined ? t('chooseModel') : `${currentProvider} / ${route.model || t('modelMissing')}`,
						onClick: () => setOpen(!open),
					},
					h(
						'span',
						{ className: 'dsh-review-model-trigger' },
						h('span', { className: 'dsh-review-model-trigger-name' }, currentLabel),
						currentProvider.length > 0 ? h('span', { className: 'dsh-review-model-trigger-provider' }, currentProvider) : null,
					),
				),
				listClassName: 'dsh-review-model-menu',
				children: [
					status === 'loading' ? h('p', { key: 'loading', className: 'dsh-review-model-status' }, t('catalogLoading')) : null,
					status === 'error'
						? h(
								'div',
								{ key: 'error', className: 'dsh-review-model-status' },
								h('span', null, t('catalogFailed')),
								typeof props.onRetry === 'function' ? h(P.Button, { variant: 'ghost', size: 'sm', disabled, onClick: props.onRetry }, t('catalogRetry')) : null,
							)
						: null,
					route?.missing === true
						? h(P.MenuGroup, { key: '__current', label: t('modelNotInCatalog') }, option({ ...route, disabled: true }))
						: null,
					...usableGroups.map((group) =>
						h(
							P.MenuGroup,
							{ key: group.id, label: group.name },
							group.models.map((model) =>
								option({
									provider: group.id,
									providerName: group.name,
									model: model.id,
									modelName: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
								}),
							),
						),
					),
				],
				onClose: () => setOpen(false),
				portal: true,
				side: 'bottom',
				align: 'start',
			});
		}

		/** 「标签 + 控件」外壳：行内字段共用，`wide` 让长内容（例如可执行文件路径）占满整行。 */
		function labelled(key, label, control, wide = false) {
			return h('div', { key, className: `dsh-review-field${wide ? ' dsh-review-field--wide' : ''}` }, h('span', { className: 'dsh-review-label' }, label), control);
		}

		/** 一行评审者：kind 决定后面显示哪些字段。 */
		function ReviewerRow(props) {
			const { t, row, index, groups, catalogStatus, onRetryCatalog, disabled } = props;
			const kind = row.kind ?? 'cli';
			const removedKind = !KINDS.includes(kind);
			const update = (patch) => props.onChange({ ...row, ...patch });
			const fields = [];
			if (kind === 'subagent') {
				// `provider` 是 subagent 服务实现（默认 spawn），不是模型 provider。
				// 绝大多数部署只有 spawn，把它摆在表单里只会和「模型 provider」混淆——
				// 所以默认不渲染，只有配置里真的写了别的值时才显示出来（改得动、看得见）。
				const serviceProvider = typeof row.provider === 'string' ? row.provider.trim() : '';
				if (serviceProvider.length > 0 && serviceProvider !== 'spawn') {
					fields.push(
						labelled(
							'provider',
							t('reviewerServiceProvider'),
							h(
								'div',
								{ className: 'dsh-review-model-field' },
								h(P.Input, { value: row.provider ?? '', placeholder: 'spawn', disabled, onChange: (event) => update({ provider: event.target.value }) }),
								h('p', { className: 'dsh-review-hint' }, t('reviewerServiceProviderHint')),
							),
							true,
						),
					);
				}
				fields.push(
					labelled(
						'agentModel',
						t('reviewerAgentModel'),
						h(
							'div',
							{ className: 'dsh-review-model-field' },
							h(ModelPicker, {
								id: `reviewer-${index}-agent-model`,
								t,
								groups,
								status: catalogStatus,
								provider: row.agentProvider,
								model: row.agentModel,
								disabled,
								onRetry: onRetryCatalog,
								onChange: (patch) => update(patch),
							}),
							groups.length > 0 && (typeof row.agentModel !== 'string' || row.agentModel.length === 0)
								? h('p', { className: 'dsh-review-hint' }, t('reviewerModelHint'))
								: null,
						),
						true,
					),
				);
			} else {
				fields.push(
					labelled('preset', t('reviewerPreset'), h(Dropdown, {
						id: `reviewer-${index}-preset`,
						value: row.preset ?? 'custom',
						options: CLI_PRESETS.map((preset) => ({ value: preset, label: preset })),
						disabled,
						onChange: (value) => update({ preset: value, executable: value === 'custom' ? row.executable : presetExecutable(value) }),
					})),
					labelled('executable', t('reviewerExecutable'), h(P.Input, { id: `reviewer-${index}-executable`, value: row.executable ?? '', placeholder: 'codex', disabled, onChange: (event) => update({ executable: event.target.value }) }), true),
					h(P.Input, { key: 'model', value: row.model ?? '', placeholder: t('reviewerModel'), disabled, onChange: (event) => update({ model: event.target.value }) }),
				);
			}
			return h(
				'div',
				{ className: 'dsh-review-card' },
				// head 只放「身份 + 开关 + 删除」；类型另起一行，窄面板下也不会挤成一团。
				h(
					'div',
					{ className: 'dsh-review-card-head' },
					h('label', { className: 'dsh-review-card-head-label', htmlFor: `reviewer-${index}-id` }, 'id'),
					h(P.Input, { id: `reviewer-${index}-id`, value: row.id ?? '', placeholder: t('reviewerId'), disabled, onChange: (event) => update({ id: event.target.value }) }),
					h(P.Switch, { checked: row.enabled !== false, label: t('reviewerEnabled'), disabled, onChange: (next) => update({ enabled: next }) }),
					h(P.Button, { variant: 'ghost', size: 'sm', disabled, onClick: () => props.onRemove() }, t('remove')),
				),
				removedKind ? h('p', { className: 'dsh-review-invalid' }, `${t('reviewerKindRemoved')}${kind}`) : null,
				h(
					'div',
					{ className: 'dsh-review-card-kind' },
					h('span', { className: 'dsh-review-label' }, t('reviewerKind')),
					h(P.SegmentedControl, {
						id: `reviewer-${index}-kind`,
						label: '',
						value: kind,
						disabled,
						options: [
							{ value: 'cli', label: t('reviewerKindCli') },
							{ value: 'subagent', label: t('reviewerKindSubagent') },
						],
						onChange: (value) => update({ kind: value }),
					}),
				),
				h('div', { className: 'dsh-review-card-grid' }, fields),
				h(
					'div',
					{ className: 'dsh-review-field' },
					h('span', { className: 'dsh-review-label' }, t('reviewerLabel')),
					h(P.Input, { value: row.label ?? '', placeholder: '', disabled, onChange: (event) => update({ label: event.target.value }) }),
				),
			);
		}

		/** 评审者列表编辑器。 */
		function ReviewersEditor(props) {
			const rows = props.rows;
			return h(
				'div',
				{ className: 'dsh-review-editor' },
				rows.length === 0 ? h('p', { className: 'dsh-review-hint' }, props.t('noReviewers')) : null,
				rows.map((row, index) =>
					h(ReviewerRow, {
						// 用位置做 key：行只增删、不重排，而 id 是可编辑的——把 id 放进 key 会让
						// 每敲一个字符就换 key、输入框被重新挂载而失焦。
						key: index,
						t: props.t,
						row,
						index,
						groups: props.groups,
						catalogStatus: props.catalogStatus,
						onRetryCatalog: props.onRetryCatalog,
						disabled: props.disabled,
						onChange: (next) => props.onChange(rows.map((entry, position) => (position === index ? next : entry))),
						onRemove: () => props.onChange(rows.filter((entry, position) => position !== index)),
					}),
				),
				h(P.Button, { variant: 'outline', size: 'sm', disabled: props.disabled, onClick: () => props.onChange([...rows, newReviewerRow(rows.length + 1, props.groups)]) }, props.t('addReviewer')),
			);
		}

		/** 从 body 里删掉空字段：YAML/GUI 两边都不会留下 `when: ""` 这种噪声。 */
		function cleanupModeBody(body) {
			const cleaned = { ...body };
			for (const key of Object.keys(cleaned)) {
				const value = cleaned[key];
				const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0) || (typeof value === 'number' && !Number.isFinite(value));
				if (empty) delete cleaned[key];
			}
			return cleaned;
		}

		/** 一行模式。 */
		function ModeRow(props) {
			const { t, row, index, reviewerOptions, disabled } = props;
			const body = row.body;
			const update = (patch) => props.onChange({ name: row.name, body: { ...body, ...patch } });
			const replace = (next) => props.onChange({ name: row.name, body: cleanupModeBody(next) });
			const inline = (key, label, control) =>
				h(
					'div',
					{ className: 'dsh-review-field' },
					h('span', { className: 'dsh-review-label' }, label),
					control,
					key === 'when' ? h('p', { className: 'dsh-review-hint' }, t('modeWhenHint')) : null,
				);
			return h(
				'div',
				{ className: 'dsh-review-card' },
				h(
					'div',
					{ className: 'dsh-review-card-head' },
					h(P.Input, { value: row.name, placeholder: t('modeName'), disabled, onChange: (event) => props.onChange({ name: event.target.value, body }) }),
					h(P.SegmentedControl, {
						id: `mode-${index}-strength`,
						label: '',
						value: body.strength ?? 'standard',
						disabled,
						options: STRENGTHS.map((strength) => ({ value: strength, label: strength })),
						onChange: (value) => update({ strength: value }),
					}),
					h(P.Button, { variant: 'ghost', size: 'sm', disabled, onClick: () => props.onRemove() }, t('remove')),
				),
				h(
					'div',
					{ className: 'dsh-review-card-grid' },
					inline(
						'reviewers',
						t('modeReviewers'),
						h(MultiSelect, {
							id: `mode-${index}-reviewers`,
							values: Array.isArray(body.reviewers) ? body.reviewers : [],
							options: reviewerOptions,
							emptyLabel: t('modeReviewersHint'),
							disabled,
							onChange: (values) => update({ reviewers: values }),
						}),
					),
					inline(
						'when',
						t('modeWhen'),
						h(Dropdown, {
							id: `mode-${index}-when`,
							value: body.when ?? '',
							options: [
								{ value: '', label: t('modeWhenOff') },
								{ value: 'always', label: t('modeWhenAlways') },
								{ value: 'complex', label: t('modeWhenComplex') },
								{ value: 'never', label: t('modeWhenNever') },
							],
							disabled,
							onChange: (value) => replace({ ...body, when: value === '' ? undefined : value }),
						}),
					),
					inline(
						'minChangedLines',
						t('modeMinLines'),
						h(P.Input, {
							value: body.minChangedLines === undefined ? '' : String(body.minChangedLines),
							placeholder: '',
							disabled,
							onChange: (event) => replace({ ...body, minChangedLines: event.target.value === '' ? undefined : Number(event.target.value) }),
						}),
					),
				),
				h('textarea', {
					className: 'dsh-review-textarea',
					value: body.prompt ?? '',
					placeholder: t('modePrompt'),
					disabled,
					spellCheck: false,
					rows: 2,
					onChange: (event) => update({ prompt: event.target.value }),
				}),
				h(P.Input, { value: body.description ?? '', placeholder: t('modeDescription'), disabled, onChange: (event) => update({ description: event.target.value }) }),
			);
		}

		/** 模式列表编辑器。 */
		function ModesEditor(props) {
			const rows = props.rows;
			const addRow = () => {
				const taken = new Set(rows.map((row) => row.name));
				let name = 'mode';
				let index = 2;
				while (taken.has(name)) name = `mode-${index++}`;
				props.onChange([...rows, { name, body: { strength: 'standard' } }]);
			};
			return h(
				'div',
				{ className: 'dsh-review-editor' },
				rows.length === 0 ? h('p', { className: 'dsh-review-hint' }, props.t('noModes')) : null,
				rows.map((row, index) =>
					h(ModeRow, {
						key: index, // 同上：模式名可编辑，不能进 key
						t: props.t,
						row,
						index,
						reviewerOptions: props.reviewerOptions,
						disabled: props.disabled,
						onChange: (next) => props.onChange(rows.map((entry, position) => (position === index ? next : entry))),
						onRemove: () => props.onChange(rows.filter((entry, position) => position !== index)),
					}),
				),
				h(P.Button, { variant: 'outline', size: 'sm', disabled: props.disabled, onClick: addRow }, props.t('addMode')),
			);
		}

		/* ────────────────────────── 页面 ────────────────────────── */

		/** 普通字段：按 control 选控件，全部写回同一个 staged 模型。 */
		function Field(props) {
			const { t, field, state, actions, disabled, catalog, reviewersText, modesText } = props;
			const labelKey = field.label ?? field.path;
			const hintKey = field.hint;
			const id = fieldId(field.path);
			const overridden = state?.overridden === true;
			const invalid = state?.invalid === true;
			const text = state?.text ?? '';
			const invalidLabel = field.control === 'number' ? t('invalidNumber') : t('invalidChoice');
			const shell = (children, hint) =>
				h(FieldShell, {
					id,
					label: t(labelKey),
					hint: hint === undefined ? (hintKey === undefined ? undefined : t(hintKey)) : hint,
					overridden,
					overriddenLabel: t('overridden'),
					resetLabel: t('reset'),
					invalid,
					invalidLabel,
					disabled,
					onReset: () => actions.resetField(field.path),
					children,
				});

			if (field.control === 'switch') {
				return shell(h(P.Switch, { checked: text === 'true', label: '', disabled, onChange: (next) => actions.edit(field.path, next ? 'true' : 'false') }));
			}
			if (field.control === 'segmented') {
				return shell(
					h(P.SegmentedControl, {
						id,
						label: '',
						value: text === '' ? 'auto' : text,
						options: [
							{ value: 'zh', label: '中文' },
							{ value: 'en', label: 'English' },
							{ value: 'auto', label: 'auto' },
						],
						disabled,
						onChange: (next) => actions.edit(field.path, next),
					}),
				);
			}
			if (field.control === 'mode') {
				const names = modeRows(modesText)
					.map((row) => row.name)
					.filter((name) => name.trim().length > 0);
				if (names.length === 0) {
					return shell(h(P.Input, { id, value: text, disabled, placeholder: t('noModes'), onChange: (event) => actions.edit(field.path, event.target.value) }), t('noModes'));
				}
				return shell(
					h(Dropdown, {
						id,
						value: text,
						options: [{ value: '', label: t('defaultModeNone') }, ...names.map((name) => ({ value: name, label: name }))],
						disabled,
						placeholder: t('defaultModeNone'),
						onChange: (next) => actions.edit(field.path, next),
					}),
				);
			}
			if (field.control === 'checklist') {
				const values = splitList(text);
				const options = reviewerRows(reviewersText)
					.map((row) => row.id)
					.filter((value) => typeof value === 'string' && value.length > 0)
					.map((value) => ({ value, label: value }));
				for (const value of values) if (!options.some((option) => option.value === value)) options.push({ value, label: value });
				if (options.length === 0) {
					return shell(h(P.Input, { id, value: text, disabled, onChange: (event) => actions.edit(field.path, event.target.value) }));
				}
				return shell(
					h(MultiSelect, {
						id,
						values,
						options,
						disabled,
						emptyLabel: t('defaultReviewersHint'),
						onChange: (next) => actions.edit(field.path, next.join(', ')),
					}),
				);
			}
			// number / text：官方单值控件（自带校验与覆盖提示）。
			return h(P.SettingsValueField, {
				id,
				label: t(labelKey),
				hint: hintKey === undefined ? undefined : t(hintKey),
				invalidLabel,
				overriddenLabel: t('overridden'),
				resetLabel: t('reset'),
				numeric: field.numeric === true,
				disabled,
				text,
				overridden,
				invalid,
				onEdit: (value) => actions.edit(field.path, value),
				onReset: () => actions.resetField(field.path),
			});
		}

		/** `reviewers` / `modes`：结构化编辑器 + 折叠的原始 JSON 兜底。 */
		function StructuredEditor(props) {
			const { t, field, state, actions, disabled, catalog, reviewersText } = props;
			const [showJson, setShowJson] = useState(false);
			const isReviewers = field.control === 'reviewers';
			void field.label; // 标题由外层分区/子分组给出
			const text = state?.text ?? '';
			const groups = catalogGroups(catalog);
			const rows = isReviewers ? reviewerRows(text) : modeRows(text);
			const onChange = (next) => actions.edit(field.path, isReviewers ? serializeReviewers(next) : serializeModes(next));
			const reviewerIds = reviewerRows(reviewersText)
				.map((row) => ({ value: row.id, label: typeof row.label === 'string' && row.label.length > 0 ? row.label : row.id }))
				.filter((option) => typeof option.value === 'string' && option.value.length > 0);
			return h(
				'div',
				{ className: 'dsh-review-structured' },
				// 外层分区/子分组已经给了标题，这里只放动作（原来 modes 那里误显示成 defaultMode）。
				h(
					'div',
					{ className: 'dsh-review-structured-head' },
					state?.overridden ? h('span', { className: 'dsh-review-badge' }, t('overridden')) : null,
					state?.overridden ? h(P.Button, { variant: 'ghost', size: 'sm', disabled, onClick: () => actions.resetField(field.path) }, t('reset')) : null,
					h(P.Button, { variant: 'ghost', size: 'sm', onClick: () => setShowJson(!showJson) }, t(showJson ? 'hideJson' : 'showJson')),
				),
				h(
					'div',
					{ className: 'dsh-review-structured-body' },
					isReviewers
						? h(ReviewersEditor, { t, rows, groups, catalogStatus: catalog?.status, onRetryCatalog: props.onRetryCatalog, disabled, onChange })
						: h(ModesEditor, { t, rows, reviewerOptions: reviewerIds, disabled, onChange }),
				),
				showJson
					? h(
							FieldShell,
							{
								id: fieldId(field.path),
								label: t('showJson'),
								hint: t('jsonHint'),
								overridden: state?.overridden === true,
								overriddenLabel: t('overridden'),
								resetLabel: t('reset'),
								invalid: state?.invalid === true,
								invalidLabel: t(isReviewers ? 'invalidReviewer' : 'invalidMode'),
								disabled,
								onReset: () => actions.resetField(field.path),
							},
							h('textarea', {
								id: fieldId(field.path),
								className: 'dsh-review-textarea dsh-review-textarea--mono',
								value: text,
								disabled,
								spellCheck: false,
								rows: 8,
								onChange: (event) => actions.edit(field.path, event.target.value),
							}),
						)
					: null,
				state?.invalid ? h('p', { className: 'dsh-review-invalid' }, t(isReviewers ? 'invalidReviewer' : 'invalidMode')) : null,
			);
		}


		/**
		 * 页面样式。
		 *
		 * 宿主不会替第三方页面排版，class 名没有配套 CSS 就是「一堆浏览器默认样式」——
		 * 所以这里自己注入一份，并且**刻意沿用官方 settings-form 的度量与设计变量**
		 * （字号 13/12、0.5px 分隔线、`--dsw-radius-md`、`--dsw-alias-label-*`），
		 * 让这一页看起来和官方设置页是同一套东西，亮暗主题也自动跟随。
		 */
		const STYLES = `
.dsh-review-group { margin: 0; padding: 0; }
.dsh-review-group + .dsh-review-group {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
}
h4.dsh-review-group-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
h5.dsh-review-subgroup-title {
  margin: 0 0 2px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-review-subgroup { margin-top: 16px; }
.dsh-review-group-head {
  appearance: none;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  text-align: left;
  color: inherit;
  cursor: pointer;
  border-radius: var(--dsw-radius-sm);
}
.dsh-review-group-head:hover .dsh-review-group-title { color: var(--dsw-alias-state-business-primary); }
.dsh-review-group-head:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dsh-review-caret {
  flex: none;
  width: 8px;
  height: 8px;
  margin: 0 2px;
  border-right: 1.5px solid var(--dsw-alias-label-tertiary);
  border-bottom: 1.5px solid var(--dsw-alias-label-tertiary);
  transform: rotate(-45deg);
  transform-origin: 60% 60%;
}
.dsh-review-caret.is-open { transform: rotate(45deg); }
.dsh-review-group-action {
  margin-left: auto;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-review-group-body > .dsh-review-subgroup:first-child { margin-top: 12px; }

/* 顶部「启用的评审者」：一张有分隔线的卡片列表 */
.dsh-review-active-list {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
  border-radius: var(--dsw-radius-md);
  overflow: hidden;
}
.dsh-review-active-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 8px 14px;
}
.dsh-review-active-item + .dsh-review-active-item {
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
}
.dsh-review-active-text {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.dsh-review-active-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-review-active-id {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-4);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}
.dsh-review-active-meta {
  flex: 0 1 auto;
  max-width: 46%;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary);
}

/* 通用字段：与官方 settings-form/fields 同一套度量 */
.dsh-review-field {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 12px 0;
}
/* 输入框要占满整格；其余控件（开关、分段、下拉、复选组）保持自然宽度左对齐 */
.dsh-review-field > input,
.dsh-review-card-grid > input { width: 100%; box-sizing: border-box; }
.dsh-review-field + .dsh-review-field {
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
}
.dsh-review-label-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-review-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-review-badge {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-4);
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}
.dsh-review-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-review-invalid {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary);
}
.dsh-review-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
}

/* 合并后的模型选择器：触发器里「模型名 + provider 名」，菜单里按 provider 分组 */
.dsh-review-model-field {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.dsh-review-model-trigger {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}
.dsh-review-model-trigger-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-review-model-trigger-provider {
  flex: none;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-review-model-menu { min-width: 240px; }
.dsh-review-model-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--dsw-radius-md);
  background: none;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.dsh-review-model-option:hover:not(:disabled),
.dsh-review-model-option:focus-visible {
  background: var(--dsw-alias-bg-layer-4);
  outline: none;
}
.dsh-review-model-option.is-selected { background: var(--dsw-alias-bg-layer-3); }
.dsh-review-model-option:disabled { cursor: default; opacity: 0.75; }
.dsh-review-model-option-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.dsh-review-model-option-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-review-model-option-id {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-review-model-check {
  flex: none;
  width: 16px;
  text-align: center;
  font-size: 13px;
  color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
.dsh-review-model-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0;
  padding: 6px 8px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-review-model-fallback {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
}
.dsh-review-model-fallback-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
}
.dsh-review-model-fallback-row > input { flex: 1 1 140px; min-width: 0; }
.dsh-review-catalog-status {
  display: flex;
  align-items: center;
  gap: 12px;
}
.dsh-review-catalog-status > .dsh-review-hint { flex: 1; }

/* 结构化编辑器：一行一块卡片 */
.dsh-review-editor { display: flex; flex-direction: column; }
.dsh-review-editor > button { align-self: flex-start; margin-top: 12px; }
.dsh-review-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25));
  border-radius: var(--dsw-radius-md);
}
.dsh-review-card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-review-card-head > input { flex: 1 1 180px; min-width: 0; }
.dsh-review-card-head-label {
  flex: none;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-review-card-kind {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-review-card-kind > .dsh-review-label { flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-review-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr));
  gap: 4px 16px;
}
.dsh-review-card-grid > .dsh-review-field { padding: 6px 0; border-top: 0; }
.dsh-review-field--wide { grid-column: 1 / -1; }
.dsh-review-structured-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0 2px;
}
.dsh-review-structured-body {
  display: flex;
  flex-direction: column;
  padding-bottom: 4px;
}
.dsh-review-textarea {
  width: 100%;
  min-height: 88px;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(0, 0, 0, 0.16));
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-3, transparent);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary, inherit);
  resize: vertical;
  box-sizing: border-box;
}
.dsh-review-textarea:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary, #4d6bfe);
}
.dsh-review-textarea--mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.dsh-review-textarea:disabled { color: var(--dsw-alias-label-tertiary, inherit); }

/* 自动保存状态行：紧挨着保存按钮，用一个小圆点表示状态 */
.dsh-review-autosave {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-review-autosave-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.45;
}
.dsh-review-autosave[data-state='saved'] .dsh-review-autosave-dot { opacity: 1; }
.dsh-review-autosave[data-state='saving'] .dsh-review-autosave-dot,
.dsh-review-autosave[data-state='pending'] .dsh-review-autosave-dot {
  background: var(--dsw-alias-state-business-primary, #4d6bfe);
  opacity: 1;
}
.dsh-review-autosave[data-state='failed'],
.dsh-review-autosave[data-state='blocked'] { color: var(--dsw-alias-state-error-primary, #d93026); }
.dsh-review-autosave[data-state='failed'] .dsh-review-autosave-dot,
.dsh-review-autosave[data-state='blocked'] .dsh-review-autosave-dot { opacity: 1; }
`.trim();

		/** 注入一次样式；已注入过（HMR/重挂载）就不再重复插标签。 */
		function injectStyles() {
			if (typeof document === 'undefined' || document.head === undefined) return () => {};
			const tagId = '@deepseek-ai/dsh-review/client.css';
			if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {};
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-review';
			tag.dataset.pluginCss = tagId;
			tag.textContent = STYLES;
			document.head.appendChild(tag);
			return () => {
				/* 保持与官方页面一致：样式标签留在文档里，靠 dataset 标记去重 */
			};
		}

		/** 可折叠分区：高级配置默认收起。 */
		function CollapsibleSection(props) {
			return h(
				'section',
				{ className: 'dsh-review-group' },
				h(
					'button',
					{
						type: 'button',
						id: props.id,
						className: 'dsh-review-group-head',
						'aria-expanded': props.open,
						onClick: props.onToggle,
					},
					h('span', { className: `dsh-review-caret${props.open ? ' is-open' : ''}`, 'aria-hidden': 'true' }),
					h('span', { className: 'dsh-review-group-title' }, props.title),
					h('span', { className: 'dsh-review-group-action' }, props.open ? props.collapseLabel : props.expandLabel),
				),
				props.hint ? h('p', { className: 'dsh-review-hint' }, props.hint) : null,
				props.open ? h('div', { className: 'dsh-review-group-body' }, props.children) : null,
			);
		}

		/**
		 * 顶部列表：勾选要用的评审者。
		 *
		 * 这里只列「评审者定义」里启用的项——用户最关心的就是这一屏，所以放在最上面，
		 * 而且勾选是唯一入口（一个都不勾 = 不启用，与宿主侧语义一致）。
		 */
		function ActiveReviewers(props) {
			const { t, reviewersText, selectedText, disabled, onToggle } = props;
			const info = reviewerChoices(reviewersText, selectedText);
			const rows = [...info.choices, ...info.unknown];
			return h(
				'div',
				{ className: 'dsh-review-active' },
				rows.length === 0
					? h('p', { className: 'dsh-review-hint' }, t('activeEmpty'))
					: h(
							'ul',
							{ className: 'dsh-review-active-list' },
							rows.map((row) =>
								h(
									'li',
									{ key: row.id, className: 'dsh-review-active-item' },
									h(P.Switch, { checked: row.checked, label: '', disabled, onChange: (next) => onToggle(row.id, next) }),
									h(
										'span',
										{ className: 'dsh-review-active-text' },
										row.label.length > 0 && row.label !== row.id ? h('span', { className: 'dsh-review-active-name' }, row.label) : null,
										h('code', { className: 'dsh-review-active-id' }, row.id),
										h(
											'span',
											{ className: 'dsh-review-active-meta', title: row.title },
											row.kind === 'unknown' ? t('activeUnknownMeta') : [row.kind, row.target].filter((part) => typeof part === 'string' && part.length > 0).join(' · '),
										),
									),
								),
							),
						),
				info.selectedCount === 0 && rows.length > 0 ? h('p', { className: 'dsh-review-invalid' }, t('activeNoneSelected')) : null,
				info.disabledCount > 0 ? h('p', { className: 'dsh-review-hint' }, t('activeDisabledNote').replace('{count}', String(info.disabledCount))) : null,
				info.unknown.length > 0 ? h('p', { className: 'dsh-review-hint' }, `${t('activeUnknownNote')} ${info.unknown.map((row) => row.id).join('、')}`) : null,
			);
		}

		/** dsh-review 的配置页。 */
		function ReviewConfigPage(props) {
			const t = props.t;
			const [advancedOpen, setAdvancedOpen] = useState(false);
			const view = props.useReviewConfigForm((snapshot) => snapshot);
			const catalog = typeof props.useReviewCatalog === 'function' ? props.useReviewCatalog((snapshot) => snapshot) : props.catalog;
			const autosave = typeof props.useReviewAutosave === 'function' ? props.useReviewAutosave((snapshot) => snapshot) : props.autosave;
			if (props.view === 'summary') return t('summary');
			const actions = { edit: props.edit, resetField: props.resetField, save: props.save, discard: props.discard };
			const disabled = !view.shell.writable || view.shell.saving;
			const reviewersText = view.fields.reviewers?.text ?? '';
			const modesText = view.fields.modes?.text ?? '';
			const renderField = (field) =>
				field.control === 'reviewers' || field.control === 'modes'
					? h(StructuredEditor, { key: field.path, t, field, state: view.fields[field.path], actions, disabled, catalog, reviewersText, onRetryCatalog: props.reloadCatalog })
					: h(Field, {
							key: field.path,
							t,
							field,
							state: view.fields[field.path],
							actions,
							disabled,
							catalog,
							reviewersText,
							modesText,
						});
			return h(
				P.SettingsForm,
				{ labels: formLabels(t), state: view.shell, onSave: props.save, onDiscard: props.discard },
				// 自动保存状态放在最上面：打开页面就知道这一页会自动保存，
				// 不必滚到最底下才发现有个保存按钮。
				h(AutoSaveStatus, { key: 'autosave', t, status: autosave?.status }),
				catalog?.status === 'loading' ? h('p', { className: 'dsh-review-hint' }, t('catalogLoading')) : null,
				catalog?.status === 'error'
					? h(
							'div',
							{ className: 'dsh-review-catalog-status' },
							h('p', { className: 'dsh-review-hint' }, t('catalogFailed')),
							typeof props.reloadCatalog === 'function'
								? h(P.Button, { variant: 'ghost', size: 'sm', disabled, onClick: props.reloadCatalog }, t('catalogRetry'))
								: null,
						)
					: null,
				// 1) 用户最关心的：启用哪些评审者（最上面）
				h(
					'section',
					{ className: 'dsh-review-group', 'data-section': 'active' },
					h('h4', { className: 'dsh-review-group-title' }, t('groupActive')),
					h('p', { className: 'dsh-review-hint' }, t('activeHint')),
					h(ActiveReviewers, {
						t,
						reviewersText,
						selectedText: view.fields.defaultReviewers?.text ?? '',
						disabled,
						onToggle: (id, next) => actions.edit('defaultReviewers', toggleSelection(view.fields.defaultReviewers?.text ?? '', id, next)),
					}),
				),
				// 2) 这些评审者是怎么定义的
				h(
					'section',
					{ className: 'dsh-review-group', 'data-section': 'reviewers' },
					h('h4', { className: 'dsh-review-group-title' }, t('groupReviewers')),
					FIELDS.filter((field) => field.section === 'reviewers').map(renderField),
				),
				// 3) 高级配置：默认收起
				h(
					CollapsibleSection,
					{
						id: 'dsh-review-advanced',
						title: t('groupAdvanced'),
						hint: t('advancedHint'),
						open: advancedOpen,
						expandLabel: t('expandSection'),
						collapseLabel: t('collapseSection'),
						onToggle: () => setAdvancedOpen(!advancedOpen),
					},
					ADVANCED_GROUPS.map((group) =>
						h(
							'div',
							{ key: group.key, className: 'dsh-review-subgroup' },
							h('h5', { className: 'dsh-review-subgroup-title' }, t(group.label)),
							FIELDS.filter((field) => field.section === 'advanced' && field.group === group.key).map(renderField),
						),
					),
				),
			);
		}

		/* ────────────────────────── 挂载 ────────────────────────── */

		/** 必需服务（cordis fiber inject）。`remote.session` 用可选取用，所以不列进来。 */
		const inject = ['slots', 'locale', 'configForms'];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-review: dictionaries');
			ctx.effect(() => injectStyles(), 'dsh-review: styles');

			// 表单模型：staged 编辑 + 一次原子写入，和官方设置页共用同一套机制。
			const model = new P.SettingsFormModel(
				ctx.configForms.get(ENTRY),
				FIELDS.map((field) => field.spec),
			);
			const store = model.bind(() => ({
				shell: model.shell(),
				fields: Object.fromEntries(FIELDS.map((field) => [field.path, model.field(field.path)])),
			}));
			ctx.effect(
				() => () => {
					// 先停掉待触发的自动保存，再释放模型：否则定时器会在 dispose 之后再写一次。
					auto.disposed = true;
					clearAutoTimer();
					autoListeners.clear();
					model.dispose();
				},
				'dsh-review: form subscription',
			);
			const modelActions = model.actions();

			/**
			 * 自动保存。
			 *
			 * 官方 `SettingsFormModel` 是刻意做成「暂存 + 点保存」的，但那个保存按钮在页面最下面，
			 * 很容易被忘掉。这里在它之上加一层防抖自动保存：每次编辑后 `delayMs` 毫秒内没有新编辑
			 * 就落盘。安全性由宿主侧保证——写入会校验整份配置、失败就拒绝，所以半途的取值写不坏配置。
			 *
			 * 三个必须自己处理的坑：
			 * 1. **冲突**：官方模型在首次暂存时记下 revision（`baseline ??=`），写入被拒后不会刷新，
			 *    于是后续保存会一直用过期 revision 被拒。失败时丢掉草稿（清掉 baseline）再按原样
			 *    重新暂存一遍，就能拿到新 revision 重试一次。
			 * 2. **保存期间又编辑**：官方 `save()` 遇到 `saving` 会直接返回，那几个字会挂在草稿里。
			 *    所以保存结束后若仍有草稿，要再排一轮。
			 * 3. **离开页面**：卸载时 SettingsForm 会调 discard，必须先等在途保存结束、把剩下的写完，
			 *    再丢草稿；否则最后几个字会丢。
			 *
			 * 另外保存可能抛异常（模型实现或传输层），所以整段包 try/catch：异常时如实报 failed
			 * 并把重试标记复位，绝不能把状态永远卡在 saving。
			 */
			const auto = {
				delayMs: AUTO.delayMs,
				timer: undefined,
				/** 用户这次会话里动过的字段 → 最后一次动作，冲突恢复时按它精确重放。 */
				touched: new Map(),
				/**
				 * 保存期间到达的编辑，先存在这里。
				 *
				 * 官方模型的 `save()` 在成功后会 `staged.clear()`——把这次保存**期间**暂存的草稿
				 * 一起清掉（它假设界面在 saving 时是禁用的）。禁用有个渲染窗口，快速输入仍可能撞上，
				 * 所以这里把这类编辑缓冲下来，等这次保存结束后再暂存。
				 */
				pending: new Map(),
				disposed: false,
				snapshot: { status: 'idle' },
			};
			const autoListeners = new Set();
			const publishAuto = (status) => {
				auto.snapshot = { status };
				for (const listener of [...autoListeners]) {
					try {
						listener();
					} catch {
						/* 一个订阅者出错不影响保存 */
					}
				}
			};
			const autoStore = {
				getSnapshot: () => auto.snapshot,
				subscribe: (listener) => {
					autoListeners.add(listener);
					return () => autoListeners.delete(listener);
				},
			};
			/** 把一次编辑动作落进模型（冲突重放与缓冲重放共用）。 */
			const applyGesture = (field, gesture, text) => {
				if (gesture === 'reset') modelActions.resetField(field);
				else modelActions.edit(field, text ?? model.field(field)?.text ?? '');
			};
			/** 保存期间缓冲下来的编辑，现在补上。 */
			const flushPendingEdits = () => {
				if (auto.pending.size === 0) return;
				const queued = [...auto.pending.entries()];
				auto.pending.clear();
				for (const [field, record] of queued) applyGesture(field, record.gesture, record.text);
			};
			const clearAutoTimer = () => {
				if (auto.timer === undefined) return;
				clearTimeout(auto.timer);
				auto.timer = undefined;
			};
			/**
			 * 冲突恢复：只重放用户真正动过的字段，并且保持原来的动作语义
			 * （`edit` 写入 / `resetField` 清除）。全量重放会依赖模型内部比较才不至于写多余字段，
			 * 没必要冒那个险。
			 */
			const replayTouched = () => {
				// **先抓文本再丢草稿**：discard 会清掉暂存值，之后 `model.field(f).text` 读到的
				// 是已落盘的旧值——用它重放等于把用户的编辑悄悄换成原值，还报告保存成功。
				const replay = [...auto.touched.entries()].map(([field, gesture]) => ({
					field,
					gesture,
					text: model.field(field)?.text ?? '',
				}));
				modelActions.discard();
				for (const { field, gesture, text } of replay) applyGesture(field, gesture, text);
			};
			/**
			 * 落一次盘，最多尝试两次：第一次被拒（冲突）或抛异常时，按原样重放一遍再试一次。
			 * 两次都不成就如实返回 false——不无限重试。
			 */
			const saveWithRetry = async () => {
				const attempt = async () => {
					await model.save();
					return !model.shell().failed;
				};
				for (let round = 0; round < 2; round += 1) {
					let landed = false;
					try {
						landed = await attempt();
					} catch {
						landed = false; // 抛异常按「没落盘」处理，和冲突同一条恢复路径
					}
					if (landed) return true;
					if (round === 0) replayTouched();
				}
				return false;
			};
			const writeNow = async () => {
				clearAutoTimer();
				if (auto.disposed) return;
				try {
					const shell = model.shell();
					if (!shell.writable) return publishAuto('idle');
					if (shell.invalid) return publishAuto('blocked');
					if (!shell.dirty) {
						auto.touched.clear();
						return publishAuto('saved');
					}
					// 正在保存：这一轮没有意义，交给在途那次的收尾去补缓冲 + 重新排队。
					if (shell.saving) return publishAuto('pending');
					publishAuto('saving');
					const landed = await saveWithRetry();
					flushPendingEdits();
					if (!landed) return publishAuto('failed');
					const after = model.shell();
					if (!after.dirty) auto.touched.clear();
					if (after.invalid) return publishAuto('blocked');
					if (after.dirty) return scheduleAutoSave();
					return publishAuto('saved');
				} catch {
					// 只有我们自己的代码（取字段文本、重放）出错才会到这里
					return publishAuto('failed');
				}
			};
			const scheduleAutoSave = () => {
				if (auto.disposed) return;
				clearAutoTimer();
				publishAuto('pending');
				auto.timer = setTimeout(() => {
					auto.timer = undefined;
					void writeNow();
				}, auto.delayMs);
				auto.timer?.unref?.();
			};
			const actions = {
				edit: (field, text) => {
					auto.touched.set(field, 'edit');
					// 保存期间先缓冲，避免被这次保存的 staged.clear() 顺手清掉。
					if (model.shell().saving) {
						auto.pending.set(field, { gesture: 'edit', text });
						return publishAuto('pending');
					}
					modelActions.edit(field, text);
					scheduleAutoSave();
				},
				resetField: (field) => {
					auto.touched.set(field, 'reset');
					if (model.shell().saving) {
						auto.pending.set(field, { gesture: 'reset' });
						return publishAuto('pending');
					}
					modelActions.resetField(field);
					scheduleAutoSave();
				},
				save: () => void writeNow(),
				/**
				 * 离开页面：SettingsForm 卸载时会调这里。
				 *
				 * 不能直接 `writeNow()` + `discard()`——官方模型遇到「正在保存」会拒绝第二次
				 * 保存，而 discard 会立刻清掉草稿，于是**保存期间敲进去的那几个字就丢了**。
				 * 所以：等这次保存结束 → 再把剩下的写完 → 只有确实写完才丢弃草稿。
				 */
				discard: () => {
					void (async () => {
						const deadline = Date.now() + 3_000;
						while (model.shell().saving && Date.now() < deadline) {
							await new Promise((resolve) => setTimeout(resolve, 20));
						}
						flushPendingEdits();
						await writeNow();
						const after = model.shell();
						if (!after.dirty && !after.failed) modelActions.discard();
					})();
				},
			};

			// 宿主模型目录（provider / model 下拉的数据源）：可选能力，拿不到就退回手填。
			//
			// 每次变化都换成新对象：宿主用 useSyncExternalStore 消费这个快照，原地改字段
			// 会让 Object.is 认为「没变」，目录晚到时页面不重渲染（看起来就是下拉一直空的）。
			let catalog = { status: 'idle', groups: [], failures: [] };
			const listeners = new Set();
			const catalogStore = {
				getSnapshot: () => catalog,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			};
			const notify = () => {
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch {
						/* 一个订阅者出错不该拖垮表单 */
					}
				}
			};
			// `remote.session` 是命名空间服务：有的组合能直接 get 到，有的要从 `remote` 上取。
			// 每次都重新取：插件 apply 时服务可能还没注册，不能把 undefined 缓存下来。
			const pickRemote = (scope) => {
				try {
					const service = scope?.get?.('remote');
					if (service?.session?.modelCatalog !== undefined) return service.session;
				} catch {
					/* 换下一条路 */
				}
				try {
					return scope?.get?.('remote.session');
				} catch {
					return undefined;
				}
			};
			let loading = false;
			const loadCatalog = async (scope) => {
				const remote = pickRemote(scope === undefined ? ctx : scope);
				if (loading) return false;
				// 服务还没就绪：保持 idle，等 `remote.session` 注册后由 inject / 事件再试。
				if (typeof remote?.modelCatalog !== 'function') return false;
				loading = true;
				catalog = { ...catalog, status: 'loading' };
				notify();
				try {
					const response = await remote.modelCatalog();
					if (response?.ok === true) {
						catalog = {
							status: 'ready',
							groups: Array.isArray(response.value?.groups) ? response.value.groups : [],
							failures: Array.isArray(response.value?.failures) ? response.value.failures : [],
						};
					} else {
						catalog = { ...catalog, status: 'error' };
					}
				} catch {
					catalog = { ...catalog, status: 'error' };
				}
				loading = false;
				notify();
				return catalog.status === 'ready';
			};
			/**
			 * 首次加载的时机。
			 *
			 * 这里不能用「apply 时取一次 remote」的写法：刚装好插件、页面第一次打开时，
			 * `remote.session` 往往还没注册，那一刻取到 undefined 就再也不会重试，模型下拉
			 * 会一直是空的（关掉插件再开才恢复）。正确做法是声明依赖，让宿主在服务就绪时
			 * 回调；服务注册事件再兜一层，覆盖“底座在、子服务晚到”的部署。
			 */
			let injected = false;
			if (typeof ctx.inject === 'function') {
				try {
					ctx.inject(['remote.session'], (scope) => {
						void loadCatalog(scope);
					});
					injected = true;
				} catch {
					/* 宿主不支持动态依赖时退回一次性加载 */
				}
			}
			if (!injected) {
				// 老宿主 / 测试桩没有动态 inject：至少按当前上下文试一次。
				ctx.effect(() => {
					void loadCatalog();
					return () => {};
				}, 'dsh-review: model catalog');
			}
			if (typeof ctx.on === 'function') {
				try {
					ctx.on('internal/service', (name) => {
						if (name === 'remote' || name === 'remote.session') void loadCatalog();
					});
				} catch {
					/* 事件通道不可用就靠 inject 的回调 */
				}
			}
			for (const event of ['llm/adapters-updated', 'settings/document-updated']) {
				try {
					const bus = ctx.get?.('remote') ?? ctx.remote;
					bus?.$on?.(event, () => loadCatalog());
				} catch {
					/* 事件通道不可用就用一次性加载 */
				}
			}

			const register = (name, key) =>
				ctx.slots.register(
					{
						name,
						key,
						locale: NS,
						inject: () => ({
							hooks: { reviewConfigForm: store, reviewCatalog: catalogStore, reviewAutosave: autoStore },
							catalog,
							reloadCatalog: () => void loadCatalog(),
							...actions,
						}),
					},
					ReviewConfigPage,
				);

			// 两个座位都占：行页（key `包名#行 id`）与包页（key 包名）。
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
		// 仅供 selftest 覆盖纯逻辑（表格转换、目录映射、选项推导）；宿主与浏览器都不读它。
		exports.__internals = {
			splitList,
			parseJson,
			reviewerRows,
			serializeReviewers,
			modeRows,
			serializeModes,
			cleanupModeBody,
			STYLES,
			injectStyles,
			AUTO,
			reviewerTarget,
			reviewerTargetFull,
			reviewerChoices,
			toggleSelection,
			catalogGroups,
			modelRoutes,
			findModelRoute,
			currentModelRoute,
			newReviewerRow,
			presetExecutable,
			FIELDS,
			ADVANCED_GROUPS,
			KINDS,
			CLI_PRESETS,
			STRENGTHS,
		};
		return module.exports;
	},
});