/**
 * 报告里展示路径的安全 helper。
 *
 * 路径来自 git 输出：tracked 文件走 `--numstat`（可能带引号转义），未跟踪文件
 * 走 `status -z`（可以包含换行、反引号、双向控制字符等）。这些内容会进入
 * Markdown 报告，也会进入评审者提示词，所以展示前必须收敛：
 *
 * - 去掉控制字符与双向控制字符（防止把 `P1` 伪装成 `P0`、把行序颠倒）；
 * - 反引号换成 `?`，避免提前闭合行内代码；
 * - 换行换成 `?`，避免伪造新的列表项/标题；
 * - 单名与整条列表都有长度预算，避免长路径挤掉 findings。
 */

/** 控制字符、双向控制字符、行/段分隔符与反引号。 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Bidi_Control}`]/gu;

/** 单条路径的安全展示文本；默认最多 160 字符。 */
export function safeDisplayPath(value, max = 160) {
	const text = String(value).replace(UNSAFE, '?');
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * 一组路径的 Markdown 预览。
 *
 * - 按**原始路径**去重（同一个文件在 staged + unstaged 都出现时只列一次）；
 * - 单条截断到 `maxItem`；
 * - 最终字符串（含分隔符、反引号与“等 N 个”后缀）**严格不超过** `maxTotal`：
 *   超预算时从尾部删条目，删到只剩一条仍超就把单条截短。
 * - 最多 `maxItems` 个；被省略的数量用去重后的总数表示。
 *
 * @param {Iterable<string>} paths
 * @param {{ maxItems?: number, maxTotal?: number, maxItem?: number }} [options]
 * @returns {string}
 */
export function formatPathList(paths, { maxItems = 12, maxTotal = 600, maxItem = 160 } = {}) {
	if (maxTotal <= 0) return '';
	const seen = new Set();
	for (const path of paths) seen.add(String(path));
	if (seen.size === 0) return '';
	const all = [...seen];

	const items = [];
	for (const raw of all) {
		if (items.length >= maxItems) break;
		items.push(safeDisplayPath(raw, Math.min(maxItem, Math.max(1, maxTotal))));
	}

	// 从完整列表开始，逐步删尾部条目，直到最终文本（含后缀）落进预算。
	for (let count = items.length; count >= 1; count -= 1) {
		const omitted = seen.size - count;
		const suffix = omitted > 0 ? ` 等 ${seen.size} 个` : '';
		const text = `${items.slice(0, count).map((item) => `\`${item}\``).join('、')}${suffix}`;
		if (text.length <= maxTotal) return text;
	}

	// 预算小到连一条带反引号的路径都放不下：至少给一个截断后的路径，且不超预算。
	const first = safeDisplayPath(all[0], Math.min(maxItem, Math.max(1, maxTotal)));
	return first.length <= maxTotal ? first : first.slice(0, Math.max(1, maxTotal));
}