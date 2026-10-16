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

/** 工作目录是否在 git 仓库里。 */
async function isGitRepo(ctx, cwd, signal) {
	const result = await runGit(ctx, { cwd, argv: ['git', 'rev-parse', '--is-inside-work-tree'], signal, maxBytes: 4096 });
	return result.ok && result.stdout.trim() === 'true';
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

/** 未跟踪文件的正文；太大或像二进制的直接跳过。 */
/** 未跟踪文件的总行数（读不到就算 0，不影响主流程）。 */
function untrackedLines(paths, cwd) {
	let total = 0;
	for (const path of paths) {
		try {
			const text = readFileSync(isAbsolute(path) ? path : join(cwd, path), 'utf8');
			if (text.length === 0) continue;
			total += text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
		} catch {
			/* 读不到就不计 */
		}
	}
	return total;
}

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

/** job 标签 / 卡片标题用的短描述。 */
export function describeCall(reviewers, target) {
	const ids = reviewers.map((reviewer) => reviewer.id).join(',');
	const base = typeof target?.base === 'string' ? target.base.trim() : '';
	const commit = typeof target?.commit === 'string' ? target.commit.trim() : '';
	const instructions = typeof target?.instructions === 'string' ? target.instructions.trim() : '';
	const scope = base.length > 0 ? `--base ${base}` : commit.length > 0 ? `--commit ${commit}` : instructions.length > 0 ? '--uncommitted' : '--uncommitted';
	return `review(${ids}) ${scope}`;
}

/**
 * 收集一次评审需要的全部材料。
 *
 * @returns 摘要（永远有）+ 可选 diff 正文包。
 */
export async function collectChanges(ctx, settings, target, cwd, signal, { packet }) {
	const summary = { files: 0, additions: 0, deletions: 0, fileNames: [], empty: true };
	const notes = [];
	const result = { summary, status: '', statText: '', packet: undefined, notes, isRepo: false };

	if (!(await isGitRepo(ctx, cwd, signal))) {
		notes.push('工作目录不是 git 仓库：无法收集 diff（评审者只能看到它们自己能读到的内容）。');
		return result;
	}
	result.isRepo = true;

	// porcelain 格式的文件名一律相对仓库根（不是 cwd），未跟踪文件要先解析到根再读。
	const rootResult = await runGit(ctx, { cwd, argv: ['git', 'rev-parse', '--show-toplevel'], signal, maxBytes: 4096 });
	const repoRoot = rootResult.ok && rootResult.stdout.trim().length > 0 ? rootResult.stdout.trim() : cwd;

	// `-uall`：未跟踪的目录要展开成文件，否则只会看到一个 `?? lib/` 而拿不到内容。
	const statusResult = await runGit(ctx, { cwd, argv: ['git', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '-uall'], signal, maxBytes: 1024 * 1024 });
	const entries = statusResult.ok ? parseStatusZ(statusResult.stdout) : [];
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
			// 「1 个文件，+0 / -0」，看起来像没有改动。
			const lines = untrackedLines(untracked, cwd);
			if (lines > 0) summary.additions += lines;
			notes.push(
				`${untracked.length} 个未跟踪的新文件不在 \`git diff\` 里${lines > 0 ? `（已按 ${lines} 行新增计入规模）` : ''}${packet ? '，正文已单独附在「未跟踪的新文件」' : ''}`,
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
		if (!out.ok) continue;
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