/**
 * 变更收集：把「评审哪个范围」翻译成 git 命令，并把结果整理成一份可以喂给
 * 外部模型的 diff 包。
 *
 * 两条路径分开：
 *
 * - **摘要**永远收集（status + numstat），用于报告头、空改动判断、模式策略；
 * - **正文（packet）**只有需要 diff 的评审者才收集——codex 预设自己会跑 git，
 *   给它喂一遍 diff 纯属浪费上下文。
 *
 * 所有 git 调用都走宿主侧 `ctx.subprocess`，argv 直传、不经 shell。
 */

import { readFileSync, statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

/** 单条 git 命令的结果。 */
async function runGit(ctx, { cwd, argv, signal, maxBytes = 8 * 1024 * 1024 }) {
	const spec = {
		argv,
		cwd,
		env: {},
		graceMs: 5_000,
		...(signal === undefined ? {} : { signal }),
		stdio: {
			stdin: 'ignore',
			stdout: { maxBytes, spill: { maxBytes } },
			stderr: { maxBytes: 64 * 1024, spill: { maxBytes: 256 * 1024 } },
		},
	};
	let proc;
	try {
		proc = ctx.subprocess.spawn(spec);
	} catch (error) {
		return { ok: false, code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), spawnFailed: true };
	}
	let outcome;
	try {
		outcome = await proc.done;
	} catch (error) {
		return { ok: false, code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), spawnFailed: true };
	}
	const read = (channel) => {
		try {
			return proc.collected?.[channel]?.readFrom(0) ?? { text: '', lossy: false };
		} catch {
			return { text: '', lossy: false };
		}
	};
	const out = read('stdout');
	const err = read('stderr');
	let stdout = out.text;
	if (out.lossy) stdout += `\n[git 输出被截断；完整输出：${out.spillPath ?? '(不可用)'}]`;
	return {
		ok: outcome.exitCode === 0,
		code: outcome.exitCode,
		stdout,
		stderr: err.text,
	};
}

/**
 * 仓库探测：把「工作目录不是仓库」与「git 跑不起来」分开。
 *
 * 以前 `isGitRepo` 把两者都压成 `false`，于是取消、或 git 不可用，都会被报成
 * 「工作目录不是 git 仓库」。
 * @returns `{ isRepo, failure }`：`failure` 有值表示探测本身失败（而不是「不是仓库」）。
 */
async function probeRepo(ctx, cwd, signal) {
	const result = await runGit(ctx, { cwd, argv: ['git', 'rev-parse', '--is-inside-work-tree'], signal, maxBytes: 4096 });
	if (signal?.aborted === true) return { isRepo: false, failure: 'review 已取消' };
	if (result.spawnFailed === true) return { isRepo: false, failure: `无法运行 git：${(result.stderr || '').trim() || '启动失败'}` };
	if (result.ok && result.stdout.trim() === 'true') return { isRepo: true, failure: undefined };
	// 只有明确的「not a git repository」才算「不是仓库」。
	// dubious ownership、权限不足、仓库损坏同样是退出码 128 + stderr：把它们当「不是仓库」
	// 会让调用方以为「这里本来就没得评」，然后照样白起一轮评审者。
	const stderr = result.stderr.trim();
	if (/not a git repositor/i.test(stderr)) return { isRepo: false, failure: undefined };
	return {
		isRepo: false,
		failure: `git rev-parse 失败（退出码 ${result.code ?? 'none'}）：${stderr.split('\n')[0] || result.stdout.trim().split('\n')[0] || '没有输出'}`,
	};
}

/** `--numstat` 的加法：`12\t3\tpath`。二进制文件是 `-\t-\tpath`。 */
function parseNumstat(text) {
	let additions = 0;
	let deletions = 0;
	const files = [];
	for (const line of text.split('\n')) {
		if (line.trim().length === 0) continue;
		const [add, del, ...rest] = line.split('\t');
		const path = rest.join('\t');
		if (path.length === 0) continue;
		files.push(path);
		if (add !== '-' && del !== '-') {
			additions += Number.parseInt(add, 10) || 0;
			deletions += Number.parseInt(del, 10) || 0;
		}
	}
	return { additions, deletions, files };
}

/** `git status --porcelain=v1 -z` 的条目 → `{status, path}`。 */
function parseStatusZ(text) {
	const tokens = text.split('\0').filter((token) => token.length > 0);
	const entries = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.length < 3) continue;
		const status = token.slice(0, 2);
		const path = token.slice(3);
		// 重命名/复制条目后面还跟着原路径，跳过它。
		if (status.startsWith('R') || status.startsWith('C')) index += 1;
		entries.push({ status, path });
	}
	return entries;
}

/**
 * 校验 base / commit 是否真的存在。
 *
 * 以前不校验：git 命令失败只会记进材料说明，于是照样起评审者（实测白跑 140 秒），最后
 * codex 自己说「没有 diff 可评」，而汇总状态还是 completed——最难排查的一种失败。
 *
 * 归因必须分开（实测 git 的行为）：`rev-parse --verify --quiet` **找不到**时退出码 1、
 * stderr 为空；仓库坏了/git 不可用则退出码 128 + fatal 文案，或进程根本起不来。
 * 把后者也报成「这个分支不存在」会把排查引向错误方向；取消时更要立刻终止，
 * 不能静默继续（默认 waitMs=0 时后续 job 用的是独立 controller，不继承这里的信号）。
 *
 * @returns 出错时的说明；一切正常返回 undefined。
 */
export async function assertRevisionExists(ctx, cwd, target, signal) {
	const pending = [['base', '--base'], ['commit', '--commit']]
		.map(([key, flag]) => [flag, typeof target?.[key] === 'string' ? target[key].trim() : ''])
		.filter(([, rev]) => rev.length > 0);
	if (pending.length === 0) return undefined;

	const repo = await probeRepo(ctx, cwd, signal);
	if (repo.failure !== undefined) return repo.failure;
	// 不是仓库：交给 collectChanges 去说明，这里不抢着报「分支不存在」。
	if (!repo.isRepo) return undefined;

	for (const [flag, rev] of pending) {
		const result = await runGit(ctx, { cwd, argv: ['git', 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`], signal, maxBytes: 4096 });
		if (signal?.aborted === true) return 'review 已取消';
		if (result.spawnFailed === true) return `无法运行 git：${(result.stderr || '').trim() || '启动失败'}`;
		if (result.ok && result.stdout.trim().length > 0) continue;
		// 没有退出码 = 进程被信号带走之类，无法断定 revision 不存在。
		if (result.code === null || result.code === undefined) {
			return `无法确认 ${flag} 「${rev}」是否存在：${(result.stderr || result.stdout).trim() || 'git 没有返回退出码'}`;
		}
		// 只有「git 正常跑完、明确说找不到」（退出码 1 且无 stderr）才归因为 revision 不存在。
		if (result.code !== 0 && result.stderr.trim().length > 0) {
			return `${flag} 「${rev}」查不到：${result.stderr.trim().split('\n')[0]}（git 退出码 ${result.code}）`;
		}
		return `${flag} 「${rev}」不是一个有效的分支或提交（仓库里找不到它）。请换成存在的分支/提交，或去掉这个参数改评未提交的改动。`;
	}
	return undefined;
}

/* 未跟踪文件的「变更规模」统计预算：只用于显示，绝不能因此读得没边。 */
const UNTRACKED_COUNT_PER_FILE = 256 * 1024;
const UNTRACKED_COUNT_TOTAL = 4 * 1024 * 1024;

/** 只读文件开头最多 `length` 字节：不把整个文件读进内存。 */
async function readPrefix(absolute, length) {
	const handle = await open(absolute, 'r');
	try {
		const buffer = Buffer.allocUnsafe(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/** 数换行：与旧口径一致——不以换行结尾时最后一行也算一行。 */
function countNewlines(buffer) {
	let breaks = 0;
	for (let index = 0; index < buffer.length; index += 1) {
		if (buffer[index] === 0x0a) breaks += 1;
	}
	return buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a ? breaks + 1 : breaks;
}

/**
 * 未跟踪文件的总行数（读不到就算 0，不影响主流程）。
 *
 * 只能用来显示变更规模，但**不能**因此读得没边：早先的实现对整个文件
 * `readFileSync` + `split('\n')`，而 `git status -uall` 会把每个未跟踪目录展开成文件列表
 * ——一个没被忽略的日志、sqlite 或构建产物就能把宿主事件循环卡住，连评审者的超时定时器
 * 都跑不起来（上限形同虚设）。packet 为 false 的评审者（如 codex）同样会走到这里。
 *
 * 现在：先 stat 过滤普通文件，单文件与合计都有字节上限，按块异步读，可被 signal 取消。
 * 读不全就置 `partial`，调用方把行数标成「至少 N」而不是假装精确。
 */
async function countUntrackedLines(paths, root, { signal, perFile = UNTRACKED_COUNT_PER_FILE, total = UNTRACKED_COUNT_TOTAL } = {}) {
	let lines = 0;
	let used = 0;
	let partial = false;
	for (const path of paths) {
		if (signal?.aborted) return { lines, partial: true };
		if (used >= total) return { lines, partial: true };
		// porcelain 的路径一律相对仓库根（不是 cwd），子目录会话下必须按根解析。
		const absolute = isAbsolute(path) ? path : join(root, path);
		let size;
		try {
			const info = await stat(absolute);
			if (!info.isFile()) continue;
			size = info.size;
		} catch {
			partial = true;
			continue;
		}
		if (size === 0) continue;
		const budget = Math.min(size, perFile, total - used);
		let text;
		try {
			text = await readPrefix(absolute, budget);
		} catch {
			partial = true;
			continue;
		}
		// 读过的字节一律计入**总**预算——二进制也一样。否则一堆未跟踪的二进制产物每个都能
		// 读满单文件上限，总量限制形同虚设（评审者超时上限照样被拖死）。
		used += text.length;
		// 疑似二进制：不计行数（与 readUntracked 的口径一致）。
		if (text.subarray(0, 8192).includes(0)) continue;
		if (budget < size) partial = true;
		lines += countNewlines(text);
	}
	return { lines, partial };
}

/** 未跟踪文件的正文；太大或像二进制的直接跳过。 */
function readUntracked(path, cwd, limit) {
	const absolute = isAbsolute(path) ? path : join(cwd, path);
	let size;
	try {
		const stat = statSync(absolute);
		if (!stat.isFile()) return { skipped: '不是普通文件' };
		size = stat.size;
	} catch {
		return { skipped: '读取失败' };
	}
	if (size > 512 * 1024) return { skipped: `文件过大（${size} 字节）` };
	let buffer;
	try {
		buffer = readFileSync(absolute);
	} catch {
		return { skipped: '读取失败' };
	}
	if (buffer.subarray(0, 8192).includes(0)) return { skipped: '疑似二进制' };
	let body = buffer.toString('utf8');
	if (body.length > limit) body = `${body.slice(0, limit)}\n[… 文件过长，已截断 …]`;
	return { body };
}

/** 按 `diff --git` 边界切分 patch。 */
function splitPatch(patch) {
	const lines = patch.split('\n');
	const chunks = [];
	let current = [];
	for (const line of lines) {
		if (line.startsWith('diff --git ') && current.length > 0) {
			chunks.push(current.join('\n'));
			current = [line];
			continue;
		}
		current.push(line);
	}
	if (current.length > 0) chunks.push(current.join('\n'));
	return chunks;
}

/**
 * 给 diff 正文做预算控制：单文件截断 → 总量/文件数截断，并把省略的文件名记下来。
 * 宁可让模型知道「有文件没看到」，也不要静默丢内容。
 */
function budgetPatch(patch, { maxTotal, maxPerFile, maxFiles }) {
	const chunks = splitPatch(patch).filter((chunk) => chunk.trim().length > 0);
	const included = [];
	const omitted = [];
	const notes = [];
	let total = 0;

	for (const chunk of chunks) {
		if (included.length >= maxFiles) {
			const name = firstPathOf(chunk);
			omitted.push(name);
			continue;
		}
		let body = chunk;
		if (body.length > maxPerFile) {
			body = `${body.slice(0, maxPerFile)}\n[… 该文件 diff 过长，已截断 …]`;
			notes.push(`${firstPathOf(chunk)}：diff 超过 ${maxPerFile} 字符，已截断`);
		}
		if (total + body.length > maxTotal && included.length > 0) {
			omitted.push(firstPathOf(chunk));
			continue;
		}
		included.push(body);
		total += body.length;
	}

	if (omitted.length > 0) {
		notes.push(`${omitted.length} 个文件的 diff 因预算被省略：${omitted.slice(0, 20).join(', ')}${omitted.length > 20 ? ' …' : ''}`);
	}
	return { text: included.join('\n'), omitted, notes, truncated: omitted.length > 0 || notes.length > 0 };
}

function firstPathOf(chunk) {
	const match = chunk.match(/^diff --git a\/(.+?) b\//m);
	return match?.[1] ?? '(未知文件)';
}

/** 报告头用的范围描述。 */
export function describeTarget(target) {
	const base = typeof target?.base === 'string' ? target.base.trim() : '';
	const commit = typeof target?.commit === 'string' ? target.commit.trim() : '';
	if (base.length > 0) return `相对 ${base} 的改动`;
	if (commit.length > 0) return `提交 ${commit} 的改动`;
	return '未提交的改动';
}

/**
 * 指令在标题里的短标识。
 *
 * 只标「有没有 instructions」不够：两条**不同**的指令会拼出同一个标题，调用卡片依旧分不清。
 * 所以取前 24 个字符；被截断时再附 4 位指纹，保证不同指令的标题一定不同，且保持可读。
 */
function shortInstructions(text) {
	const flat = text.replace(/\s+/g, ' ').trim();
	const head = flat.slice(0, 24);
	if (flat.length <= 24) return `「${head}」`;
	let hash = 0x811c9dc5;
	for (let index = 0; index < flat.length; index += 1) {
		hash = Math.imul(hash ^ flat.charCodeAt(index), 0x01000193) >>> 0;
	}
	return `「${head}…」#${hash.toString(16).slice(-4)}`;
}

/** job 标签 / 卡片标题用的短描述。 */
export function describeCall(reviewers, target) {
	const ids = reviewers.map((reviewer) => reviewer.id).join(',');
	const base = typeof target?.base === 'string' ? target.base.trim() : '';
	const commit = typeof target?.commit === 'string' ? target.commit.trim() : '';
	const instructions = typeof target?.instructions === 'string' ? target.instructions.trim() : '';
	const scope = base.length > 0 ? `--base ${base}` : commit.length > 0 ? `--commit ${commit}` : '--uncommitted';
	// 带上 instructions 的调用在卡片标题上要看得出来（否则两次调用长得一样）。
	return `review(${ids}) ${scope}${instructions.length > 0 ? ` +instructions${shortInstructions(instructions)}` : ''}`;
}

/**
 * 收集一次评审需要的全部材料。
 *
 * @returns 摘要（永远有）+ 可选 diff 正文包。
 */
export async function collectChanges(ctx, settings, target, cwd, signal, { packet }) {
	const summary = { files: 0, additions: 0, deletions: 0, fileNames: [], empty: true };
	const notes = [];
	// gitFailed：有任何 git 命令失败就置位，调用方据此跳过「空改动」短路（不再靠 note 文案判断）。
	const result = { summary, status: '', statText: '', packet: undefined, notes, isRepo: false, gitFailed: false };

	const repo = await probeRepo(ctx, cwd, signal);
	if (!repo.isRepo) {
		// 探测本身失败（git 不可用 / 被取消）与「不是仓库」不是一回事，说明与标志位都分开。
		notes.push(
			repo.failure === undefined
				? '工作目录不是 git 仓库：无法收集 diff（评审者只能看到它们自己能读到的内容）。'
				: `${repo.failure}：无法收集 diff（评审者只能看到它们自己能读到的内容）。`,
		);
		result.gitFailed = repo.failure !== undefined;
		return result;
	}
	result.isRepo = true;

	// porcelain 格式的文件名一律相对仓库根（不是 cwd），未跟踪文件要先解析到根再读。
	const rootResult = await runGit(ctx, { cwd, argv: ['git', 'rev-parse', '--show-toplevel'], signal, maxBytes: 4096 });
	const repoRoot = rootResult.ok && rootResult.stdout.trim().length > 0 ? rootResult.stdout.trim() : cwd;

	// `-uall`：未跟踪的目录要展开成文件，否则只会看到一个 `?? lib/` 而拿不到内容。
	const statusResult = await runGit(ctx, { cwd, argv: ['git', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '-uall'], signal, maxBytes: 1024 * 1024 });
	const entries = statusResult.ok ? parseStatusZ(statusResult.stdout) : [];
	if (!statusResult.ok) {
		notes.push(`\`git status\` 失败：${(statusResult.stderr || statusResult.stdout).trim().split('\n')[0] ?? ''}`);
		// status 挂掉且 numstat 恰好是 0 文件时，不置位就会走进「未检测到需要评审的改动」
		// 的短路——正是 gitFailed 要挡的那种「git 坏了却报告没东西可评」。
		result.gitFailed = true;
	}
	result.status = entries.map((entry) => `${entry.status} ${entry.path}`).join('\n');
	const untracked = entries.filter((entry) => entry.status === '??').map((entry) => entry.path);

	/** 每个范围用同一组命令，只是参数不同。 */
	const scope = { base: target.base, commit: target.commit };
	const numstatArgs = [];
	const patchArgs = [];
	const statArgs = [];
	if (scope.base.length > 0) {
		numstatArgs.push(['git', '-c', 'core.quotepath=false', 'diff', '--numstat', scope.base]);
		statArgs.push(['git', '-c', 'core.quotepath=false', 'diff', '--stat', scope.base]);
		patchArgs.push(['git', '-c', 'core.quotepath=false', 'diff', '--no-color', '--find-renames', scope.base]);
	} else if (scope.commit.length > 0) {
		numstatArgs.push(['git', '-c', 'core.quotepath=false', 'show', '--numstat', '--format=', scope.commit]);
		statArgs.push(['git', '-c', 'core.quotepath=false', 'show', '--stat', '--format=%h %s', scope.commit]);
		patchArgs.push(['git', '-c', 'core.quotepath=false', 'show', '--patch', '--no-color', '--format=medium', scope.commit]);
	} else {
		numstatArgs.push(['git', '-c', 'core.quotepath=false', 'diff', '--numstat']);
		numstatArgs.push(['git', '-c', 'core.quotepath=false', 'diff', '--cached', '--numstat']);
		statArgs.push(['git', '-c', 'core.quotepath=false', 'diff', '--stat']);
		statArgs.push(['git', '-c', 'core.quotepath=false', 'diff', '--cached', '--stat']);
		patchArgs.push(['git', '-c', 'core.quotepath=false', 'diff', '--no-color']);
		patchArgs.push(['git', '-c', 'core.quotepath=false', 'diff', '--cached', '--no-color']);
	}

	for (const argv of numstatArgs) {
		const out = await runGit(ctx, { cwd, argv, signal });
		if (!out.ok) {
			notes.push(`\`${argv.slice(3).join(' ')}\` 失败：${(out.stderr || out.stdout).trim().split('\n')[0] ?? ''}`);
			// 结构化标志位：以前调用方靠「note 里是否含『失败』」判断，英文错误信息或
			// 别的 note 里出现同样的字就会误伤。
			result.gitFailed = true;
			continue;
		}
		const parsed = parseNumstat(out.stdout);
		summary.additions += parsed.additions;
		summary.deletions += parsed.deletions;
		summary.files += parsed.files.length;
		summary.fileNames.push(...parsed.files);
	}

	const statTexts = [];
	for (const argv of statArgs) {
		const out = await runGit(ctx, { cwd, argv, signal });
		if (out.ok && out.stdout.trim().length > 0) statTexts.push(out.stdout.trim());
	}
	result.statText = statTexts.join('\n');

	// 未跟踪文件只属于「未提交」这个范围：`git show <commit>` / `git diff <base>` 都不含
	// 它们，把它们塞进材料会让评审者报出范围之外的缺陷，也会虚增变更规模。
	const untrackedInScope = scope.base.length === 0 && scope.commit.length === 0;

	if (untracked.length > 0) {
		if (untrackedInScope) {
			summary.files += untracked.length;
			summary.fileNames.push(...untracked);
			// 新增行数按未跟踪文件的正文行数算：`git diff` 里没有它们，否则规模会显示成
			// 「1 个文件，+0 / -0」，看起来像没有改动。统计有字节上限，读不全就写「至少」。
			const counted = await countUntrackedLines(untracked, repoRoot, { signal });
			if (counted.lines > 0) summary.additions += counted.lines;
			const sizeText = counted.lines > 0 ? `（已按${counted.partial ? `至少 ${counted.lines}` : ` ${counted.lines}`} 行新增计入规模）` : '';
			notes.push(
				`${untracked.length} 个未跟踪的新文件不在 \`git diff\` 里${sizeText}${packet ? '，正文已单独附在「未跟踪的新文件」' : ''}`,
			);
		} else {
			notes.push(`${untracked.length} 个未跟踪的新文件不属于本次范围（${scope.commit.length > 0 ? `提交 ${scope.commit}` : `相对 ${scope.base}`}），未纳入材料`);
		}
	}
	// 「有没有东西可评」按范围算：base/commit 只看那个范围的 diff；未提交才把
	// `git status` 一起算进来（未跟踪文件只在这里出现）。
	const scoped = scope.base.length > 0 || scope.commit.length > 0;
	summary.empty = scoped ? summary.files === 0 : summary.files === 0 && (result.status ?? '').trim().length === 0;

	if (!packet) return result;

	const parts = [];
	const sections = [];

	if (result.statText.length > 0) sections.push(`### 变更统计\n\n\`\`\`\n${result.statText}\n\`\`\``);
	if (result.status.trim().length > 0) sections.push(`### git status\n\n\`\`\`\n${result.status}\n\`\`\``);

	for (const argv of patchArgs) {
		const out = await runGit(ctx, { cwd, argv, signal, maxBytes: 16 * 1024 * 1024 });
		if (!out.ok) {
			notes.push(`\`${argv.slice(3).join(' ')}\` 失败：${(out.stderr || out.stdout).trim().split('\n')[0] ?? ''}`);
			result.gitFailed = true;
			continue;
		}
		if (out.stdout.trim().length === 0) continue;
		parts.push(out.stdout);
	}

	let patchText = parts.join('\n');
	const budgeted = budgetPatch(patchText, {
		maxTotal: settings.maxDiffChars,
		maxPerFile: settings.maxFileDiffChars,
		maxFiles: settings.maxDiffFiles,
	});
	notes.push(...budgeted.notes);
	if (budgeted.text.trim().length > 0) sections.push(`### 完整 diff\n\n\`\`\`diff\n${budgeted.text}\n\`\`\``);

	// 未跟踪新文件：git diff 看不到，单独把正文补上（仅限「未提交」范围）。
	if (untrackedInScope && untracked.length > 0) {
		const chunks = [];
		let remaining = Math.max(0, settings.maxDiffChars - budgeted.text.length);
		for (const path of untracked.slice(0, settings.maxDiffFiles)) {
			if (remaining <= 0) {
				notes.push(`未跟踪文件超出预算，未纳入：${path}`);
				continue;
			}
			const read = readUntracked(path, repoRoot, Math.min(settings.maxUntrackedFileChars, remaining));
			if (read.skipped !== undefined) {
				notes.push(`未跟踪文件 ${path}：${read.skipped}`);
				continue;
			}
			chunks.push(`#### ${path}\n\n\`\`\`\n${read.body}\n\`\`\``);
			remaining -= read.body.length;
		}
		if (chunks.length > 0) sections.push(`### 未跟踪的新文件\n\n${chunks.join('\n\n')}`);
	}

	const text = sections.join('\n\n');
	result.packet = { text, chars: text.length, truncated: budgeted.truncated };
	return result;
}