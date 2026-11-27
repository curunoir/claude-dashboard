// Git: modified files, commits, versions of a file, ignored files.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execGit, spawnGit, fromGit } from '../git-exec.mjs';
import { t } from '../public/i18n/index.js';

// --- Git: modified files and versions of a file ------------------------------------------------

/** git in `dir` (the distribution's git for a WSL folder: git-exec.mjs). */
export const git = (dir, args, { raw = false } = {}) => execGit(dir, args, { timeout: 15_000, maxBuffer: 20 * 1024 * 1024, encoding: raw ? 'buffer' : 'utf8' });

/** Root of the repo of `dir`, as seen from here (a WSL repo's Linux path translated). */
export const topLevel = async dir => fromGit(dir, (await git(dir, ['rev-parse', '--show-toplevel'])).trim());

/** Among these relative paths (folders ending with "/"), the names of those git ignores. Outside a repo: none. */
export function ignoredByGit(dir, paths) {
  if (!paths.length) return Promise.resolve(new Set());
  return new Promise(ok => {
    const p = spawnGit(dir, ['check-ignore', '-z', '--stdin']);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => ok(new Set()));
    p.on('close', () => ok(new Set(out.split('\0').filter(Boolean).map(c => c.replace(/\/$/, '').split('/').pop()))));
    p.stdin.end(paths.join('\0') + '\0');
  });
}

/** Files modified since the last commit (staged or not, new ones included), with their lines added / removed. */
export async function gitStatus(dir) {
  const root = await topLevel(dir);
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  const lines = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].slice(0, 2), entry = lines[i].slice(3), rel = entry.replace(/\/$/, '');
    if (code[0] === 'R' || code[0] === 'C') i++; // a rename carries the old name next
    const state = code === '??' ? 'untracked' : code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : code.includes('R') ? 'renamed' : 'modified';
    // A folder: nested repository not added ("?? sub/", even with --untracked-files=all) or submodule (" M sub")
    const dir = entry.endsWith('/') || (state !== 'untracked' && state !== 'deleted' && !!fs.statSync(path.join(root, rel), { throwIfNoEntry: false })?.isDirectory());
    // Staged changes with others on top, not staged: the file can go back to its version of the index
    const partial = code !== '??' && code[0] !== ' ' && code[1] !== ' ';
    files.push({ rel, path: path.join(root, rel), state, ...(dir ? { dir: true } : {}), ...(partial ? { partial: true } : {}) });
  }
  // Lines added / removed per file, compared with the last commit
  const counts = new Map();
  for (const l of (await git(root, ['diff', 'HEAD', '--numstat', '-z']).catch(() => '')).split('\0')) {
    const [plus, minus, rel] = l.split('\t');
    if (rel) counts.set(rel.trim(), { insertions: Number(plus) || 0, deletions: Number(minus) || 0, binary: plus === '-' });
  }
  for (const f of files) Object.assign(f, counts.get(f.rel) || {});
  // New files in folders absent from the last commit: `newDir`, the highest of them ("a/b/"), lets the page offer
  // to delete such a folder
  if (files.some(f => (f.state === 'untracked' || f.state === 'added') && f.rel.includes('/'))) {
    const headDirs = new Set((await git(root, ['ls-tree', '-r', '-d', '-z', '--name-only', 'HEAD']).catch(() => '')).split('\0'));
    for (const f of files.filter(x => x.state === 'untracked' || x.state === 'added')) {
      const parts = f.rel.split('/').slice(0, -1);
      for (let k = 1; k <= parts.length; k++) {
        const d = parts.slice(0, k).join('/');
        if (!headDirs.has(d)) { f.newDir = `${d}/`; break; }
      }
    }
  }
  return { root: path.normalize(root), branch, files };
}

/**
 * Brings a file back to its state of the last commit: a new file (tracked or not) is deleted, a modified or deleted
 * file is restored, a rename undone (old name restored, new one removed). The state is read again from git, never
 * taken from the page; a file without changes is refused. `toIndex`: only the changes not staged are discarded.
 */
export async function revertChanges(file, { toIndex = false } = {}) {
  const { root, rel, entries } = await statusOf(file);
  if (!rel) throw new Error(t('server.git.outsideRepo'));
  const { code, old } = entries.find(e => e.rel === rel) || {};
  if (!code) throw new Error(t('server.git.nothingToRevert'));
  if (toIndex) {
    // Back to the version of the index: only the changes not staged go away
    if (code === '??' || code[1] === ' ') throw new Error(t('server.git.nothingToRevert'));
    return void await git(root, ['restore', '--worktree', '--', rel]);
  }
  if (code === '??') {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(t('server.errors.fileNotFound'));
    return fs.unlinkSync(file);
  }
  const inHead = await git(root, ['cat-file', '-e', `HEAD:${rel}`]).then(() => true, () => false);
  if (!inHead) await git(root, ['rm', '-f', '-q', '--', rel]); // added since the last commit (or new name)
  else await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', rel]);
  if (code[0] === 'R' && old) await git(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', old]);
}

/**
 * Deletes a folder whose files are all new (not tracked, or only added to the index since the last commit): each
 * one is deleted, then the folders left empty. Refused as soon as one of them is in the last commit or is a nested
 * repository; the files git ignores stay, and with them their folder.
 */
export async function deleteNewFolder(folder) {
  const { root, rel, entries } = await statusOf(folder);
  if (!rel) throw new Error(t('server.git.outsideRepo'));
  const inside = entries.filter(e => e.rel.startsWith(`${rel}/`));
  if (!inside.length) throw new Error(t('server.git.nothingToRevert'));
  if (inside.some(e => e.rel.endsWith('/') || (e.code !== '??' && e.code[0] !== 'A'))) throw new Error(t('server.git.folderNotNew'));
  const added = inside.filter(e => e.code !== '??').map(e => e.rel);
  // Unchanged files are not in the status: the folder must be absent from the last commit, the index hold only the added ones
  const inHead = (await git(root, ['ls-tree', '--name-only', 'HEAD', '--', rel]).catch(() => '')).trim();
  const indexed = (await git(root, ['ls-files', '-z', '--', rel])).split('\0').filter(Boolean);
  if (inHead || indexed.some(f => !added.includes(f))) throw new Error(t('server.git.folderNotNew'));
  if (added.length) await git(root, ['rm', '-f', '-q', '--', ...added]);
  for (const e of inside.filter(x => x.code === '??')) fs.rmSync(path.join(root, e.rel), { force: true });
  // Folders left empty, deepest first
  const removeEmpty = dir => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) removeEmpty(path.join(dir, d.name));
    if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
  };
  if (fs.existsSync(folder)) removeEmpty(folder);
}

/** Repository of a path (which may no longer exist), its path relative to it (null outside) and the full status. */
async function statusOf(file) {
  // The file (or its whole folder) may have been deleted: git starts from the first folder that exists
  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const root = await topLevel(dir);
  const rel = path.relative(root, file).split(path.sep).join('/');
  // Full status (a path filter would break rename detection)
  const lines = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].slice(0, 2), r = lines[i].slice(3), old = code[0] === 'R' || code[0] === 'C' ? lines[++i] : null;
    entries.push({ code, rel: r, old });
  }
  return { root, rel: rel && !rel.startsWith('..') ? rel : null, entries };
}

/** Latest commits of the branch, marking those not pushed yet. */
export async function gitCommits(dir, n = 20, skip = 0) {
  const root = await topLevel(dir);
  const out = await git(root, ['log', `-n${n}`, `--skip=${skip}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e']);
  const unpushed = new Set((await git(root, ['rev-list', '@{u}..HEAD']).catch(() => '')).split('\n').filter(Boolean));
  const commits = out.split('\x1e').map(l => l.trim()).filter(Boolean).map(l => {
    const [hash, short, subject, author, date] = l.split('\x1f');
    return { hash, short, subject, author, date, unpushed: unpushed.has(hash) };
  });
  return { root: path.normalize(root), commits };
}

/** One commit: full message and touched files (state, lines +/−). */
export async function gitCommit(dir, hash) {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new Error(t('server.git.invalidCommit'));
  const root = await topLevel(dir);
  const [header] = (await git(root, ['show', '-s', '--format=%H%x1f%s%x1f%b%x1f%an%x1f%aI', hash])).split('\n\x1e');
  const [full, subject, body, author, date] = header.split('\x1f');
  const states = new Map((await git(root, ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', hash])).split('\n').filter(Boolean)
    .map(l => { const [code, ...names] = l.split('\t'); return [names.at(-1), code[0]]; }));
  const STATES = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'added' };
  const files = (await git(root, ['diff-tree', '--root', '--no-commit-id', '-r', '--numstat', hash])).split('\n').filter(Boolean).map(l => {
    const [plus, minus, ...rest] = l.split('\t');
    const rel = rest.join('\t').replace(/^.*=> /, '').replace(/[{}]/g, '');
    return { rel, path: path.join(root, rel), state: STATES[states.get(rel)] || 'modified', insertions: Number(plus) || 0, deletions: Number(minus) || 0, binary: plus === '-' };
  });
  return { root: path.normalize(root), hash: full, subject, body: (body || '').trim(), author, date: (date || '').trim(), files };
}

// --- Review: a branch against its base, a merge request (docs/specs/2026-11-27-review-tab.md) -------------------------

const COMMIT_ID = /^[0-9a-f]{4,40}$/i;
const RANGE_STATES = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' };

/**
 * Files of `git diff --name-status -z` and `--numstat -z` (same range, renames detected): `[{ rel, state, from?,
 * insertions, deletions, binary }]`, `from` being the old name of a renamed file. Pure.
 */
export function parseRangeFiles(nameStatus, numstat) {
  const counts = new Map(), nums = String(numstat || '').split('\0');
  for (let i = 0; i < nums.length; i++) {
    const [plus, minus, name] = nums[i].split('\t');
    if (minus === undefined) continue;
    // A rename has an empty name here, followed by the old and the new one
    const rel = name || nums[i += 2];
    if (rel) counts.set(rel, { insertions: Number(plus) || 0, deletions: Number(minus) || 0, binary: plus === '-' });
  }
  const files = [], names = String(nameStatus || '').split('\0');
  for (let i = 0; i + 1 < names.length; i++) {
    const code = names[i][0], moved = code === 'R' || code === 'C';
    const from = moved ? names[++i] : null, rel = names[++i];
    if (!rel) continue;
    files.push({ rel, state: RANGE_STATES[code] || 'modified', ...(code === 'R' ? { from } : {}), insertions: 0, deletions: 0, binary: false, ...counts.get(rel) });
  }
  return files;
}

const commitOf = (root, ref) => git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(o => o.trim() || null, () => null);
const MAIN_BRANCHES = ['develop', 'main', 'master', 'dev', 'trunk'];

/**
 * What a branch is compared with: `{ name, sha }`, or null (no candidate). `wanted`: the target branch of its merge
 * request, on `remote`. Otherwise the default branch of origin, then develop, main, master… (remote first: the local
 * one may be behind). A main branch itself is compared with its upstream: what it has not pushed.
 */
export async function reviewBase(root, { wanted, remote = 'origin', branch } = {}) {
  const candidates = [];
  if (wanted) candidates.push(`${remote}/${wanted}`, `origin/${wanted}`, wanted);
  if (MAIN_BRANCHES.includes(branch)) candidates.push(`${branch}@{u}`);
  const head = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
  if (head) candidates.push(head);
  candidates.push(...MAIN_BRANCHES.map(b => `origin/${b}`), ...MAIN_BRANCHES);
  for (const name of candidates) {
    const sha = await commitOf(root, name);
    if (sha) return { name: name.endsWith('@{u}') ? (await git(root, ['rev-parse', '--abbrev-ref', name]).catch(() => name)).trim() : name, sha };
  }
  return null;
}

/**
 * The diff to review: from the merge base of `base` and `head` to `head`, or to the working tree when `head` is empty
 * (uncommitted and untracked files included: the work of a session is judged before it is committed). Returns
 * `{ root, mergeBase, head, headSha, commits, fingerprint, files }`; `fingerprint` changes as soon as the diff does.
 */
export async function gitRange(dir, { base, head = '' }) {
  if (!COMMIT_ID.test(base) || (head && !COMMIT_ID.test(head))) throw new Error(t('server.git.invalidCommit'));
  const root = await topLevel(dir), tip = head || 'HEAD';
  const headSha = await commitOf(root, tip);
  const mergeBase = (await git(root, ['merge-base', base, tip]).catch(() => base)).trim() || base;
  const range = head ? [mergeBase, head] : [mergeBase];
  const [nameStatus, numstat, count] = await Promise.all([
    git(root, ['diff', '-M', '--name-status', '-z', ...range]),
    git(root, ['diff', '-M', '--numstat', '-z', ...range]),
    git(root, ['rev-list', '--count', `${mergeBase}..${tip}`]).catch(() => '0'),
  ]);
  const files = parseRangeFiles(nameStatus, numstat);
  let untracked = '';
  if (!head) {
    for (const rel of (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) {
      const st = fs.statSync(path.join(root, rel), { throwIfNoEntry: false });
      if (!st?.isFile()) continue;
      untracked += `${rel}:${st.size}:${st.mtimeMs}\n`;
      // Lines of a new file: counted when it is small enough to be read at each reading of the tab
      const text = st.size <= 512 * 1024 ? fs.readFileSync(path.join(root, rel)) : null;
      const binary = !!text && text.subarray(0, 8000).includes(0);
      files.push({ rel, state: 'untracked', insertions: text && !binary ? text.toString('utf8').split('\n').length - (text.at(-1) === 10 ? 1 : 0) : 0, deletions: 0, binary });
    }
  }
  const fingerprint = createHash('sha1').update([mergeBase, headSha, nameStatus, numstat, untracked].join('\n')).digest('hex').slice(0, 16);
  return {
    root: path.normalize(root), mergeBase, head, headSha, commits: Number(count.trim()) || 0, fingerprint,
    files: files.map(f => ({ ...f, path: path.join(root, f.rel) })),
  };
}

/**
 * Makes the head commit of a merge request of this repo available here and returns its id: already there (its branch
 * is local or fetched), otherwise fetched from its remote into `refs/dash/mr/<n>`, without touching the working tree.
 */
export async function fetchMr(root, mr) {
  if (mr.head && await commitOf(root, mr.head)) return mr.head;
  if (!mr.remote) return null;
  const ref = `refs/dash/mr/${mr.number}`;
  const source = mr.forge === 'github' ? `refs/pull/${mr.number}/head` : `refs/merge-requests/${mr.number}/head`;
  await execGit(root, ['fetch', '--no-tags', '--quiet', mr.remote, `+${source}:${ref}`], { timeout: 60_000 });
  return (mr.head && await commitOf(root, mr.head)) || commitOf(root, ref);
}

const EDITOR_MAX_SIZE = 2 * 1024 * 1024;
/**
 * Two versions of a file for the editor. Without `commit`: the one of the last commit (empty if new) and the current
 * one (empty if deleted). With `commit`: the one before this commit and the one it left (the diff of that time).
 * With `range` `{ base, head, from }` (commit ids): the one at `base` (under its old name `from` if renamed) and the
 * one at `head`, or the current one without `head` (the diff of a review).
 */
export async function fileVersions(file, commit, range = null) {
  if (commit && !COMMIT_ID.test(commit)) throw new Error(t('server.git.invalidCommit'));
  if (range && (!COMMIT_ID.test(range.base) || (range.head && !COMMIT_ID.test(range.head)))) throw new Error(t('server.git.invalidCommit'));
  if (range) return rangeVersions(file, range);
  const dir = fs.existsSync(file) && fs.statSync(file).isDirectory() ? file : path.dirname(file);
  let root = null;
  try { root = await topLevel(fs.existsSync(dir) ? dir : path.dirname(dir)); } catch { /* outside git */ }
  if (commit && !root) {
    // File deleted since: its folder may be gone, go up to a folder of the repo
    let d = path.dirname(file);
    while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
    root = await topLevel(d);
  }
  const rel = root ? path.relative(root, file).replace(/\\/g, '/') : null;
  const version = ref => git(root, ['show', `${ref}:${rel}`], { raw: true }).catch(() => null); // null: absent at this version
  const current = commit ? await version(commit) : fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (current && current.length > EDITOR_MAX_SIZE) throw new Error(t('server.git.tooLargeForEditor'));
  let original = null;
  if (root) original = await version(commit ? `${commit}^` : 'HEAD');
  const text = b => (b ? b.toString('utf8') : '');
  const binary = [current, original].some(b => b && b.subarray(0, 8000).includes(0));
  return {
    path: file, root, binary, exists: !!current, tracked: original !== null,
    original: binary ? '' : text(original), current: binary ? '' : text(current),
    modified: !!root && (original === null ? !!current : !current || !original.equals(current)),
  };
}

/** `fileVersions` for a review range (same answer). The file may be gone from the disk: git starts from a folder that exists. */
async function rangeVersions(file, { base, head, from }) {
  let d = path.dirname(file);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  const root = await topLevel(d);
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) throw new Error(t('server.git.outsideRepo'));
  const old = typeof from === 'string' && from && !from.startsWith('/') && !from.split('/').includes('..') ? from : rel;
  const version = spec => git(root, ['show', spec], { raw: true }).catch(() => null);
  const current = head ? await version(`${head}:${rel}`) : fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? fs.readFileSync(file) : null;
  if (current && current.length > EDITOR_MAX_SIZE) throw new Error(t('server.git.tooLargeForEditor'));
  const original = await version(`${base}:${old}`);
  const binary = [current, original].some(b => b && b.subarray(0, 8000).includes(0));
  const text = b => (b ? b.toString('utf8') : '');
  return {
    path: file, root, binary, exists: !!current, tracked: original !== null,
    original: binary ? '' : text(original), current: binary ? '' : text(current),
    modified: original === null ? !!current : !current || !original.equals(current),
  };
}
