/**
 * dsh-review 的浏览器半边：在侧边栏 Plugins → dsh-review 的行/包页面上渲染配置表单。
 *
 * 这是手写的 `__ModuleLoader__` 工厂 bundle（DSH 客户端模块系统的加载格式），
 * 不需要构建工具：externals 只有 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`，
 * 两者都由宿主的静态模块表提供。
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

		const KINDS = ['cli', 'llm', 'subagent'];
		const CLI_PRESETS = ['codex', 'claude', 'gemini', 'opencode', 'cursor', 'custom'];
		const STRENGTHS = ['light', 'standard', 'deep'];

		/* ────────────────────────── 字典 ────────────────────────── */

		const zh = {
			summary: '先勾选要用的评审者，再按需调整高级配置。',
			groupActive: '启用的评审者',
			groupReviewers: '评审者定义',
			groupAdvanced: '高级配置',
			advancedHint: '模式、模型发现、语言与预算。默认收起，需要时再展开。',
			expandSection: '展开',
			collapseSection: '收起',
			activeHint: '只列出「评审者定义」里启用的那些。勾上的会被 review 工具默认使用；也可以在调用时用 reviewers 参数临时指定别的。',
			activeEmpty: '还没有评审者定义，先到下面添加一个。',
			activeNoneSelected: '一个都没勾 = 不启用任何评审者：这时调用 review 会直接报错，要求显式指定 reviewers。',
			activeDisabledNote: '另有 {count} 个评审者被「启用」开关关掉了，不在这里列出。',
			activeUnknownNote: '以下 id 在配置里被选中，但已不在评审者定义里（可能是改过 id）：',
			activeTargetCli: 'CLI',
			defaultReviewers: '启用的评审者',
			defaultReviewersHint: '勾上的会被默认使用。',
			groupBehavior: '评审行为',
			groupModes: '评审模式',
			groupDiscover: '模型发现',
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
			reviewerKindLlm: 'DSH 调模型',
			reviewerKindSubagent: '子智能体',
			reviewerPreset: 'CLI 预设',
			reviewerExecutable: '可执行文件',
			reviewerProvider: 'provider',
			reviewerModel: '模型',
			reviewerLabel: '显示名（可选）',
			reviewerEnabled: '启用',
			reviewerAgentProvider: '子智能体的 provider',
			reviewerAgentModel: '子智能体的模型',
			providerMissing: 'provider 列表不可用',
			modelMissing: '该 provider 没有模型',
			catalogLoading: '正在读取宿主模型目录…',
			catalogFailed: '宿主模型目录读取失败，下面的 provider / 模型请手动填写。',
			noReviewers: '还没有评审者。先添加一个，或用下面的原始 JSON 直接写。',
			addMode: '添加模式',
			modeName: '模式名（工具参数 mode 用它）',
			modeStrength: '强度',
			modeReviewers: '用哪些评审者',
			modeReviewersHint: '一个都不勾 = 用上面选定的默认集合。',
			modeSynthesize: '合并结论',
			modeSynthesizeHint: '评审者跑完后，让一个模型把结论合并去重。',
			modeSynthesizeReviewer: '用哪个模型汇总',
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
			discoverEnabled: '自动展开模型',
			discoverEnabledHint: '打开后把下面 provider 的模型自动纳入评审者，不必在上面一个个写。',
			discoverProviders: '要展开的 provider',
			discoverProvidersHint: '一个都不勾 = 全部已注册 provider。',
			discoverInclude: '模型白名单（glob，逗号分隔）',
			discoverIncludeHint: '例如 qwen*, glm*；留空表示不限。',
			discoverExclude: '模型黑名单（glob，逗号分隔）',
			discoverExcludeHint: '例如 *embedding*；既不会被展开，也不允许按需指名。',
			discoverLabel: '标签模板',
			discoverLabelHint: '支持 {provider} {providerName} {model} {name}。',
			discoverInDefault: '发现的模型进默认集合',
			discoverInDefaultHint: '关闭时它们只是「可用」，要显式指名才会用到。',
			discoverAdHoc: '允许按需指名 provider/model',
			discoverAdHocHint: '打开时工具参数可以直接写 bailian/kimi-k3 这类不在配置里的模型。',
			showJson: '显示原始 JSON',
			hideJson: '收起原始 JSON',
			jsonHint: '直接编辑存储值；保存时会校验（评审者必须是数组且每行有 id，模式必须是对象）。',
			invalidJson: '不是合法 JSON（或类型不对）',
			invalidReviewer: '每个评审者都要有 id，kind 只能是 cli / llm / subagent',
			invalidMode: '每个模式都要有名字，strength 只能是 light / standard / deep',
			invalidNumber: '需要一个不小于下限的整数',
			invalidChoice: '取值不合法',
			overridden: '已覆盖',
			reset: '恢复默认',
			readOnly: '本部署的设置为只读。',
			unavailable: '该插件当前未加载，暂时无法配置。',
			save: '保存',
			saving: '保存中…',
			saveFailed: '本部署没有接受这些值，已保留供你修改。',
		};

		const en = {
			summary: 'Pick the reviewers you want first, then adjust advanced settings as needed.',
			groupActive: 'Enabled reviewers',
			groupReviewers: 'Reviewer definitions',
			groupAdvanced: 'Advanced settings',
			advancedHint: 'Modes, model discovery, language, and budgets. Collapsed by default.',
			expandSection: 'Expand',
			collapseSection: 'Collapse',
			activeHint: 'Only reviewers that are enabled below are listed. Checked ones are used by default; a call may still name others with its reviewers argument.',
			activeEmpty: 'No reviewer definitions yet — add one below.',
			activeNoneSelected: 'Nothing checked means no reviewers are enabled: calling review would fail and ask for explicit reviewers.',
			activeDisabledNote: '{count} more reviewer(s) are turned off by their “enabled” switch and are not listed here.',
			activeUnknownNote: 'These ids are selected in the config but no longer defined (an id may have changed):',
			activeTargetCli: 'CLI',
			defaultReviewers: 'Enabled reviewers',
			defaultReviewersHint: 'Checked ones are used by default.',
			groupBehavior: 'Review behaviour',
			groupModes: 'Review modes',
			groupDiscover: 'Model discovery',
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
			reviewerKindLlm: 'DSH model call',
			reviewerKindSubagent: 'Subagent',
			reviewerPreset: 'CLI preset',
			reviewerExecutable: 'Executable',
			reviewerProvider: 'Provider',
			reviewerModel: 'Model',
			reviewerLabel: 'Display name (optional)',
			reviewerEnabled: 'Enabled',
			reviewerAgentProvider: 'Subagent provider',
			reviewerAgentModel: 'Subagent model',
			providerMissing: 'Provider list unavailable',
			modelMissing: 'No models for this provider',
			catalogLoading: 'Reading the host model catalog…',
			catalogFailed: 'The host model catalog could not be read; fill provider / model by hand below.',
			noReviewers: 'No reviewers yet. Add one, or write them in the raw JSON below.',
			addMode: 'Add mode',
			modeName: 'Name (referenced by the tool’s mode argument)',
			modeStrength: 'Strength',
			modeReviewers: 'Reviewers to use',
			modeReviewersHint: 'None selected means the default set chosen above.',
			modeSynthesize: 'Merge findings',
			modeSynthesizeHint: 'After the reviewers finish, one model merges and de-duplicates their findings.',
			modeSynthesizeReviewer: 'Model that merges',
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
			discoverEnabled: 'Expand models automatically',
			discoverEnabledHint: 'Pulls the providers below into the reviewer set, so you need not list them as reviewers.',
			discoverProviders: 'Providers to expand',
			discoverProvidersHint: 'None selected means every registered provider.',
			discoverInclude: 'Model allowlist (glob, comma separated)',
			discoverIncludeHint: 'e.g. qwen*, glm*; empty means no limit.',
			discoverExclude: 'Model denylist (glob, comma separated)',
			discoverExcludeHint: 'e.g. *embedding*; never expanded and refused ad hoc.',
			discoverLabel: 'Label template',
			discoverLabelHint: 'Supports {provider} {providerName} {model} {name}.',
			discoverInDefault: 'Discovered models join the default set',
			discoverInDefaultHint: 'When off they stay available but are only used when named.',
			discoverAdHoc: 'Allow naming provider/model ad hoc',
			discoverAdHocHint: 'Lets a tool call name a model that is not in the config, e.g. bailian/kimi-k3.',
			showJson: 'Show raw JSON',
			hideJson: 'Hide raw JSON',
			jsonHint: 'Edits the stored value directly; saving validates it (reviewers must be an array of objects with ids, modes an object).',
			invalidJson: 'Not valid JSON (or the wrong type)',
			invalidReviewer: 'Every reviewer needs an id, and kind must be cli / llm / subagent',
			invalidMode: 'Every mode needs a name, and strength must be light / standard / deep',
			invalidNumber: 'Needs an integer at or above the minimum',
			invalidChoice: 'Not an accepted value',
			overridden: 'Overridden',
			reset: 'Reset to default',
			readOnly: 'This deployment stores settings read-only.',
			unavailable: 'This plugin is not loaded right now, so it cannot be configured.',
			save: 'Save',
			saving: 'Saving…',
			saveFailed: 'This deployment did not accept these values; they were kept for you to fix.',
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

		/** 值 → 下拉选项；当前值不在列表里时补一条，绝不悄悄丢值。 */
		function selectOptions(entries, current) {
			const options = entries.map((entry) => ({ value: entry.value, label: entry.label }));
			const value = String(current ?? '');
			if (value.length > 0 && !options.some((option) => option.value === value)) options.push({ value, label: `${value}（不在列表里）` });
			return options;
		}

		/**
		 * `discover.enabled` 的**生效值**：宿主侧「写了 providers / include 就打开发现」的推断
		 * 在这里镜像一遍，否则开关会显示成「关」而实际是开的——同一个语义两边必须一致。
		 * 显式写了 true/false 就听它的。
		 */
		function effectiveDiscoverEnabled(enabledText, providersText, includeText) {
			const raw = String(enabledText ?? '').trim().toLowerCase();
			if (raw === 'true' || ['1', 'yes', 'on', '是', '开'].includes(raw)) return true;
			if (raw === 'false' || ['0', 'no', 'off', '否', '关'].includes(raw)) return false;
			return splitList(providersText).length > 0 || splitList(includeText).length > 0;
		}

		/** 一行评审者「指向什么」的一句话摘要（顶部列表用）。 */
		function reviewerTarget(row) {
			const kind = row.kind ?? 'cli';
			if (kind === 'llm') return `${row.provider ?? '?'}/${row.model ?? '?'}`;
			if (kind === 'subagent') return `${row.provider ?? 'spawn'}${typeof row.agentModel === 'string' && row.agentModel.length > 0 ? ` · ${row.agentModel}` : ''}`;
			return row.executable ?? row.preset ?? 'cli';
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
				checked: selected.includes(row.id),
			}));
			const unknown = selected.filter((id) => !choices.some((choice) => choice.id === id)).map((id) => ({ id, label: id, kind: 'unknown', target: '', checked: true }));
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

		/** 新增评审者行：优先给出「能直接跑」的初值（有目录就给模型评审者）。 */
		function newReviewerRow(index, groups) {
			const provider = groups?.[0];
			const model = provider?.models?.[0];
			if (provider !== undefined && model !== undefined) return { id: `reviewer-${index}`, kind: 'llm', provider: provider.id, model: model.id };
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
					const ok = parsed.every(
						(row) => row !== null && typeof row === 'object' && !Array.isArray(row) && typeof row.id === 'string' && row.id.trim().length > 0 && (row.kind === undefined || KINDS.includes(row.kind)),
					);
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
			// defaultReviewers 由顶部那屏列表渲染（section 'active'），但仍要在这里注册 spec，
			// 否则 SettingsFormModel 不认识这个字段，勾选写不回去。
			{ path: 'defaultReviewers', spec: listField('defaultReviewers'), control: 'active', section: 'active', group: 'active' },
			// 只有 reviewers 常显；其余全部归入「高级配置」的子分组。
			{ path: 'reviewers', spec: reviewersField('reviewers'), control: 'reviewers', section: 'reviewers', group: 'reviewers' },
			{ path: 'language', spec: choiceField('language', ['zh', 'en', 'auto']), control: 'segmented', section: 'advanced', group: 'behavior' },
			{ path: 'injectPolicy', spec: boolField('injectPolicy'), control: 'switch', section: 'advanced', group: 'behavior' },
			{ path: 'defaultMode', spec: choiceField('defaultMode', []), control: 'mode', section: 'advanced', group: 'behavior' },
			{ path: 'modes', spec: modesField('modes'), control: 'modes', section: 'advanced', group: 'modes' },
			{ path: 'discover.enabled', spec: boolField('discover.enabled'), control: 'switch', section: 'advanced', group: 'discover' },
			{ path: 'discover.providers', spec: listField('discover.providers'), control: 'providerChecklist', section: 'advanced', group: 'discover' },
			{ path: 'discover.include', spec: listField('discover.include'), control: 'text', section: 'advanced', group: 'discover' },
			{ path: 'discover.exclude', spec: listField('discover.exclude'), control: 'text', section: 'advanced', group: 'discover' },
			{ path: 'discover.label', spec: P.settingsTextField('discover.label'), control: 'text', section: 'advanced', group: 'discover' },
			{ path: 'discover.inDefault', spec: boolField('discover.inDefault'), control: 'switch', section: 'advanced', group: 'discover' },
			{ path: 'discover.adHoc', spec: boolField('discover.adHoc'), control: 'switch', section: 'advanced', group: 'discover' },
			{ path: 'waitMs', spec: numberField('waitMs', 0), control: 'number', numeric: true, section: 'advanced', group: 'budget' },
			{ path: 'hardTimeoutMs', spec: numberField('hardTimeoutMs', 0), control: 'number', numeric: true, section: 'advanced', group: 'budget' },
			{ path: 'maxResultChars', spec: numberField('maxResultChars', 0), control: 'number', numeric: true, section: 'advanced', group: 'budget' },
			{ path: 'maxDiffChars', spec: numberField('maxDiffChars', 0), control: 'number', numeric: true, section: 'advanced', group: 'budget' },
			{ path: 'maxFileDiffChars', spec: numberField('maxFileDiffChars', 0), control: 'number', numeric: true, section: 'advanced', group: 'budget' },
			{ path: 'maxUntrackedFileChars', spec: numberField('maxUntrackedFileChars', 0), control: 'number', numeric: true, section: 'advanced', group: 'budget' },
			{ path: 'maxArgBytes', spec: numberField('maxArgBytes', 1), control: 'number', numeric: true, section: 'advanced', group: 'budget' },
		];

		/** 常显分区（按用户关注顺序：先「启用哪些」，再「定义了哪些」）。 */
		const BASIC_SECTIONS = [
			{ key: 'active', label: 'groupActive' },
			{ key: 'reviewers', label: 'groupReviewers' },
		];

		/** 「高级配置」里的子分组顺序。 */
		const ADVANCED_GROUPS = [
			{ key: 'behavior', label: 'groupBehavior' },
			{ key: 'modes', label: 'groupModes' },
			{ key: 'discover', label: 'groupDiscover' },
			{ key: 'budget', label: 'groupBudget' },
		];

		/** path → [标签键, 提示键]。 */
		const LABELS = {
			defaultReviewers: ['defaultReviewers', 'defaultReviewersHint'],
			defaultMode: ['defaultMode', 'defaultModeHint'],
			language: ['language', 'languageHint'],
			injectPolicy: ['injectPolicy', 'injectPolicyHint'],
			waitMs: ['waitMs', 'waitMsHint'],
			hardTimeoutMs: ['hardTimeoutMs', 'hardTimeoutMsHint'],
			maxResultChars: ['maxResultChars', 'maxResultCharsHint'],
			maxDiffChars: ['maxDiffChars', 'maxDiffCharsHint'],
			maxFileDiffChars: ['maxFileDiffChars', 'maxFileDiffCharsHint'],
			maxUntrackedFileChars: ['maxUntrackedFileChars', 'maxUntrackedFileCharsHint'],
			maxArgBytes: ['maxArgBytes', 'maxArgBytesHint'],
			'discover.enabled': ['discoverEnabled', 'discoverEnabledHint'],
			'discover.providers': ['discoverProviders', 'discoverProvidersHint'],
			'discover.include': ['discoverInclude', 'discoverIncludeHint'],
			'discover.exclude': ['discoverExclude', 'discoverExcludeHint'],
			'discover.label': ['discoverLabel', 'discoverLabelHint'],
			'discover.inDefault': ['discoverInDefault', 'discoverInDefaultHint'],
			'discover.adHoc': ['discoverAdHoc', 'discoverAdHocHint'],
		};

		/** 字段 id：稳定且不含路径里的点，给 htmlFor 用。 */
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
						'aria-haspopup': 'listbox',
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

		/** 一行评审者：kind 决定后面显示哪些字段。 */
		function ReviewerRow(props) {
			const { t, row, index, providerOptions, modelsFor, disabled } = props;
			const kind = row.kind ?? 'cli';
			const update = (patch) => props.onChange({ ...row, ...patch });
			const fields = [];
			if (kind === 'llm') {
				fields.push(
					h(Dropdown, {
						key: 'provider',
						id: `reviewer-${index}-provider`,
						value: row.provider ?? '',
						options: selectOptions(providerOptions, row.provider),
						placeholder: t('providerMissing'),
						disabled,
						onChange: (value) => update({ provider: value, model: modelsFor(value)[0]?.value ?? row.model }),
					}),
					h(Dropdown, {
						key: 'model',
						id: `reviewer-${index}-model`,
						value: row.model ?? '',
						options: selectOptions(modelsFor(row.provider), row.model),
						placeholder: t('modelMissing'),
						disabled,
						onChange: (value) => update({ model: value }),
					}),
				);
			} else if (kind === 'subagent') {
				fields.push(
					h(P.Input, { key: 'provider', value: row.provider ?? '', placeholder: 'spawn', disabled, onChange: (event) => update({ provider: event.target.value }) }),
					h(Dropdown, {
						key: 'agentProvider',
						id: `reviewer-${index}-agent-provider`,
						value: row.agentProvider ?? '',
						options: selectOptions(providerOptions, row.agentProvider),
						placeholder: t('reviewerAgentProvider'),
						disabled,
						onChange: (value) => update({ agentProvider: value }),
					}),
					h(Dropdown, {
						key: 'agentModel',
						id: `reviewer-${index}-agent-model`,
						value: row.agentModel ?? '',
						options: selectOptions(modelsFor(row.agentProvider), row.agentModel),
						placeholder: t('reviewerAgentModel'),
						disabled,
						onChange: (value) => update({ agentModel: value }),
					}),
				);
			} else {
				fields.push(
					h(Dropdown, {
						key: 'preset',
						id: `reviewer-${index}-preset`,
						value: row.preset ?? 'custom',
						options: CLI_PRESETS.map((preset) => ({ value: preset, label: preset })),
						disabled,
						onChange: (value) => update({ preset: value, executable: value === 'custom' ? row.executable : presetExecutable(value) }),
					}),
					h(P.Input, { key: 'executable', id: `reviewer-${index}-executable`, value: row.executable ?? '', placeholder: 'codex', disabled, onChange: (event) => update({ executable: event.target.value }) }),
					h(P.Input, { key: 'model', value: row.model ?? '', placeholder: t('reviewerModel'), disabled, onChange: (event) => update({ model: event.target.value }) }),
				);
			}
			return h(
				'div',
				{ className: 'dsh-review-card' },
				h(
					'div',
					{ className: 'dsh-review-card-head' },
					h(P.Input, { id: `reviewer-${index}-id`, value: row.id ?? '', placeholder: t('reviewerId'), disabled, onChange: (event) => update({ id: event.target.value }) }),
					h(P.SegmentedControl, {
						id: `reviewer-${index}-kind`,
						label: '',
						value: kind,
						disabled,
						options: [
							{ value: 'cli', label: t('reviewerKindCli') },
							{ value: 'llm', label: t('reviewerKindLlm') },
							{ value: 'subagent', label: t('reviewerKindSubagent') },
						],
						onChange: (value) => update({ kind: value }),
					}),
					h(P.Switch, { checked: row.enabled !== false, label: t('reviewerEnabled'), disabled, onChange: (next) => update({ enabled: next }) }),
					h(P.Button, { variant: 'ghost', size: 'sm', disabled, onClick: () => props.onRemove() }, t('remove')),
				),
				h('div', { className: 'dsh-review-card-grid' }, fields),
				h(P.Input, { value: row.label ?? '', placeholder: t('reviewerLabel'), disabled, onChange: (event) => update({ label: event.target.value }) }),
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
						key: `${row.id ?? 'row'}-${index}`,
						t: props.t,
						row,
						index,
						providerOptions: props.providerOptions,
						modelsFor: props.modelsFor,
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
			const { t, row, index, reviewerOptions, llmOptions, disabled } = props;
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
						'synthesize',
						t('modeSynthesize'),
						h(P.Switch, { checked: body.synthesize === true, label: '', disabled, onChange: (next) => replace({ ...body, synthesize: next ? true : undefined }) }),
					),
					inline(
						'synthesizeReviewer',
						t('modeSynthesizeReviewer'),
						h(Dropdown, {
							id: `mode-${index}-synthesize-reviewer`,
							value: body.synthesizeReviewer ?? '',
							options: selectOptions(llmOptions, body.synthesizeReviewer),
							placeholder: '—',
							disabled,
							onChange: (value) => replace({ ...body, synthesizeReviewer: value }),
						}),
					),
					h(P.Input, {
						value: body.minChangedLines === undefined ? '' : String(body.minChangedLines),
						placeholder: t('modeMinLines'),
						disabled,
						onChange: (event) => replace({ ...body, minChangedLines: event.target.value === '' ? undefined : Number(event.target.value) }),
					}),
				),
				h(P.Input, { value: body.prompt ?? '', placeholder: t('modePrompt'), disabled, onChange: (event) => update({ prompt: event.target.value }) }),
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
						key: `${row.name || 'mode'}-${index}`,
						t: props.t,
						row,
						index,
						reviewerOptions: props.reviewerOptions,
						llmOptions: props.llmOptions,
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
			const [labelKey, hintKey] = LABELS[field.path] ?? [field.path, undefined];
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
				const checked = props.switchChecked === undefined ? text === 'true' : props.switchChecked;
				const inferred = props.switchChecked === true && text !== 'true';
				const hint = inferred ? `${hintKey === undefined ? '' : t(hintKey)}（当前因为写了 provider 或白名单而生效）` : undefined;
				return shell(h(P.Switch, { checked, label: '', disabled, onChange: (next) => actions.edit(field.path, next ? 'true' : 'false') }), hint);
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
						options: [{ value: '', label: '—' }, ...names.map((name) => ({ value: name, label: name }))],
						disabled,
						placeholder: '—',
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
			if (field.control === 'providerChecklist') {
				const values = splitList(text);
				const options = catalogGroups(catalog).map((group) => ({ value: group.id, label: group.name }));
				for (const value of values) if (!options.some((option) => option.value === value)) options.push({ value, label: value });
				if (options.length === 0) {
					const hint = catalog?.status === 'error' ? t('catalogFailed') : t('catalogLoading');
					return shell(h(P.Input, { id, value: text, disabled, onChange: (event) => actions.edit(field.path, event.target.value) }), hint);
				}
				return shell(
					h(MultiSelect, {
						id,
						values,
						options,
						disabled,
						emptyLabel: t('discoverProvidersHint'),
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
			const text = state?.text ?? '';
			const groups = catalogGroups(catalog);
			const providerOptions = groups.map((group) => ({ value: group.id, label: group.name }));
			const modelsFor = (provider) => (groups.find((group) => group.id === provider)?.models ?? []).map((model) => ({ value: model.id, label: model.name ?? model.id }));
			const rows = isReviewers ? reviewerRows(text) : modeRows(text);
			const onChange = (next) => actions.edit(field.path, isReviewers ? serializeReviewers(next) : serializeModes(next));
			const reviewerIds = reviewerRows(reviewersText)
				.map((row) => ({ value: row.id, label: typeof row.label === 'string' && row.label.length > 0 ? row.label : row.id }))
				.filter((option) => typeof option.value === 'string' && option.value.length > 0);
			const llmIds = reviewerRows(reviewersText)
				.filter((row) => (row.kind ?? 'cli') === 'llm')
				.map((row) => ({ value: row.id, label: typeof row.label === 'string' && row.label.length > 0 ? row.label : row.id }))
				.filter((option) => typeof option.value === 'string' && option.value.length > 0);
			return h(
				'div',
				{ className: 'dsh-review-structured' },
				h(
					'div',
					{ className: 'dsh-review-structured-head' },
					h('span', { className: 'dsh-review-label' }, t(isReviewers ? 'groupReviewers' : 'defaultMode')),
					state?.overridden ? h('span', { className: 'dsh-review-badge' }, t('overridden')) : null,
					state?.overridden ? h(P.Button, { variant: 'ghost', size: 'sm', disabled, onClick: () => actions.resetField(field.path) }, t('reset')) : null,
					h(P.Button, { variant: 'ghost', size: 'sm', onClick: () => setShowJson(!showJson) }, t(showJson ? 'hideJson' : 'showJson')),
				),
				h(
					'div',
					{ className: 'dsh-review-structured-body' },
					isReviewers
						? h(ReviewersEditor, { t, rows, groups, providerOptions, modelsFor, disabled, onChange })
						: h(ModesEditor, { t, rows, reviewerOptions: reviewerIds, llmOptions: llmIds, disabled, onChange }),
				),
				showJson
					? h(P.SettingsValueField, {
							id: fieldId(field.path),
							label: t('showJson'),
							hint: t('jsonHint'),
							invalidLabel: t(isReviewers ? 'invalidReviewer' : 'invalidMode'),
							overriddenLabel: t('overridden'),
							resetLabel: t('reset'),
							disabled,
							text,
							overridden: state?.overridden === true,
							invalid: state?.invalid === true,
							onEdit: (value) => actions.edit(field.path, value),
							onReset: () => actions.resetField(field.path),
						})
					: null,
				state?.invalid ? h('p', { className: 'dsh-review-invalid' }, t(isReviewers ? 'invalidReviewer' : 'invalidMode')) : null,
			);
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
					h('span', { className: 'dsh-review-caret' }, props.open ? '▾' : '▸'),
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
										h('span', { className: 'dsh-review-active-name' }, row.label),
										h('code', { className: 'dsh-review-active-id' }, row.id),
										h('span', { className: 'dsh-review-active-meta' }, `${row.kind}${row.target.length > 0 ? ` · ${row.target}` : ''}`),
									),
								),
							),
						),
				info.selectedCount === 0 && rows.length > 0 ? h('p', { className: 'dsh-review-invalid' }, t('activeNoneSelected')) : null,
				info.disabledCount > 0 ? h('p', { className: 'dsh-review-hint' }, t('activeDisabledNote').replace('{count}', String(info.disabledCount))) : null,
				info.unknown.length > 0 ? h('p', { className: 'dsh-review-hint' }, `${t('activeUnknownNote')}${info.unknown.map((row) => row.id).join('、')}`) : null,
			);
		}

		/** dsh-review 的配置页。 */
		function ReviewConfigPage(props) {
			const t = props.t;
			const [advancedOpen, setAdvancedOpen] = useState(false);
			const view = props.useReviewConfigForm((snapshot) => snapshot);
			const catalog = typeof props.useReviewCatalog === 'function' ? props.useReviewCatalog((snapshot) => snapshot) : props.catalog;
			if (props.view === 'summary') return t('summary');
			const actions = { edit: props.edit, resetField: props.resetField, save: props.save, discard: props.discard };
			const disabled = !view.shell.writable || view.shell.saving;
			const reviewersText = view.fields.reviewers?.text ?? '';
			const modesText = view.fields.modes?.text ?? '';
			// 只给 discover.enabled 用：把宿主的推断镜像成开关的真实状态。
			const discoverEnabledEffective = effectiveDiscoverEnabled(view.fields['discover.enabled']?.text, view.fields['discover.providers']?.text, view.fields['discover.include']?.text);
			const renderField = (field) =>
				field.control === 'reviewers' || field.control === 'modes'
					? h(StructuredEditor, { key: field.path, t, field, state: view.fields[field.path], actions, disabled, catalog, reviewersText })
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
							switchChecked: field.path === 'discover.enabled' ? discoverEnabledEffective : undefined,
						});
			return h(
				P.SettingsForm,
				{ labels: formLabels(t), state: view.shell, onSave: props.save, onDiscard: props.discard },
				catalog?.status === 'loading' ? h('p', { className: 'dsh-review-hint' }, t('catalogLoading')) : null,
				catalog?.status === 'error' ? h('p', { className: 'dsh-review-hint' }, t('catalogFailed')) : null,
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

			// 宿主模型目录（provider / model 下拉的数据源）：可选能力，拿不到就退回手填。
			const catalog = { status: 'idle', groups: [], failures: [] };
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
			const pickRemote = () => {
				try {
					const service = ctx.get?.('remote');
					if (service?.session?.modelCatalog !== undefined) return service.session;
				} catch {
					/* 换下一条路 */
				}
				try {
					return ctx.get?.('remote.session');
				} catch {
					return undefined;
				}
			};
			const remote = pickRemote();
			let loading = false;
			const loadCatalog = async () => {
				if (loading || typeof remote?.modelCatalog !== 'function') return;
				loading = true;
				catalog.status = 'loading';
				notify();
				try {
					const response = await remote.modelCatalog();
					if (response?.ok === true) {
						catalog.groups = Array.isArray(response.value?.groups) ? response.value.groups : [];
						catalog.failures = Array.isArray(response.value?.failures) ? response.value.failures : [];
						catalog.status = 'ready';
					} else {
						catalog.status = 'error';
					}
				} catch {
					catalog.status = 'error';
				}
				loading = false;
				notify();
			};
			ctx.effect(() => {
				loadCatalog();
				return () => {};
			}, 'dsh-review: model catalog');
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
						inject: () => ({ hooks: { reviewConfigForm: store, reviewCatalog: catalogStore }, catalog, ...actions }),
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
			effectiveDiscoverEnabled,
			reviewerTarget,
			reviewerChoices,
			toggleSelection,
			catalogGroups,
			selectOptions,
			newReviewerRow,
			presetExecutable,
			FIELDS,
			BASIC_SECTIONS,
			ADVANCED_GROUPS,
			KINDS,
			CLI_PRESETS,
			STRENGTHS,
		};
		return module.exports;
	},
});