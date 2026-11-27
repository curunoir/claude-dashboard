// Merge requests (GitLab) and pull requests (GitHub), read through the forge CLIs already logged in on the PC
// (`gh`, `glab`): no token to manage, no dependency. Read only. Spec: docs/specs/2026-11-27-review-tab.md.
import { execFile } from 'node:child_process';
import { execGit } from '../git-exec.mjs';
import { parseMrUrl } from '../public/core/mr-url.js';

/** `{ host, repo }` of a git remote URL (https, ssh, scp-like `git@host:group/repo.git`), otherwise null. Pure. */
export function remoteRepo(url) {
  const s = String(url || '').trim();
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i) || s.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/);
  if (!m) return null;
  const repo = m[2].replace(/\/+$/, '').replace(/\.git$/i, '');
  return repo.includes('/') ? { host: m[1].toLowerCase(), repo } : null;
}

/** The CLI of a host: `gh` for github.com, `glab` for any other (GitLab, self-hosted included). Pure. */
export const toolOf = host => (/(^|\.)github\.com$/i.test(host) ? 'gh' : 'glab');

const GH_FIELDS = 'number,title,state,isDraft,url,baseRefName,headRefName,headRefOid,statusCheckRollup';

/** CI of a GitHub pull request, from its checks: 'failed', 'running', 'success' or null (no check). Pure. */
function ghCi(checks) {
  const list = Array.isArray(checks) ? checks : [];
  if (!list.length) return null;
  const result = c => String(c.conclusion || c.state || '').toUpperCase();
  if (list.some(c => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(result(c)))) return 'failed';
  if (list.some(c => (c.status && String(c.status).toUpperCase() !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(result(c)))) return 'running';
  return 'success';
}

/** A pull request as `gh … --json` gives it, in the common shape. Pure. */
export function normalizeGh(pr) {
  if (!pr || typeof pr !== 'object' || !pr.url) return null;
  const state = String(pr.state || '').toUpperCase();
  return {
    forge: 'github', number: Number(pr.number), title: String(pr.title || ''), url: pr.url,
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open', draft: !!pr.isDraft,
    base: pr.baseRefName || '', branch: pr.headRefName || '', head: pr.headRefOid || '', ci: ghCi(pr.statusCheckRollup),
  };
}

/** A merge request as `glab … -F json` gives it (GitLab API), in the common shape. Pure. */
export function normalizeGlab(mr) {
  if (!mr || typeof mr !== 'object' || !mr.web_url) return null;
  const pipeline = String((mr.head_pipeline || mr.pipeline || {}).status || '').toLowerCase();
  const ci = !pipeline ? null : pipeline === 'success' ? 'success' : ['failed', 'canceled'].includes(pipeline) ? 'failed'
    : ['skipped', 'manual'].includes(pipeline) ? null : 'running';
  return {
    forge: 'gitlab', number: Number(mr.iid), title: String(mr.title || ''), url: mr.web_url,
    state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open', draft: !!(mr.draft ?? mr.work_in_progress),
    base: mr.target_branch || '', branch: mr.source_branch || '', head: mr.sha || mr.diff_refs?.head_sha || '', ci,
  };
}

/** Among the requests of a branch: the open one, otherwise the first (the most recent). Pure. */
export const pickMr = list => list.find(m => m.state === 'open') || list[0] || null;

// --- Calls ---------------------------------------------------------------------------------------------------------

/** JSON printed by a CLI (a notice may come before it), otherwise null. */
function jsonOf(out) {
  const s = String(out), start = s.search(/[[{]/);
  if (start < 0) return null;
  try { return JSON.parse(s.slice(start)); } catch { return null; }
}

/** Runs `gh` or `glab` without a shell: resolves `{ json }`, `{ missing: tool }` (not installed) or `{ error }`. */
const run = (tool, args) => new Promise(ok => execFile(tool, args, {
  windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GLAB_CHECK_UPDATE: 'false', NO_COLOR: '1', NO_PROMPT: '1' },
}, (err, stdout, stderr) => {
  if (err?.code === 'ENOENT') return ok({ missing: tool });
  if (err) return ok({ error: String(stderr || err.message).trim().split('\n')[0].slice(0, 300) });
  ok({ json: jsonOf(stdout) });
}));

// Answers kept a minute: the tab is read every 10 s, the forges are not
const CACHE_MS = 60_000, cache = new Map();
function cached(key, compute) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = compute();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
  return value;
}

/** The remotes of a repo that are on a forge: `[{ name, host, repo }]`, `origin` first, each repo once. */
export async function forgeRemotes(root) {
  const out = await execGit(root, ['remote', '-v'], { timeout: 15_000 }).catch(() => '');
  const seen = new Set(), remotes = [];
  for (const line of out.split('\n')) {
    const [name, url] = line.trim().split(/\s+/);
    const r = remoteRepo(url);
    if (!r || seen.has(`${r.host}/${r.repo}`.toLowerCase())) continue;
    seen.add(`${r.host}/${r.repo}`.toLowerCase());
    remotes.push({ name, ...r });
  }
  return remotes.sort((a, b) => (b.name === 'origin') - (a.name === 'origin'));
}

/** Requests of `branch` in the repo of a remote: `{ list }`, or `{ problem: { tool, missing | error } }`. */
function listOfBranch(remote, branch) {
  const tool = toolOf(remote.host);
  return cached(`branch:${remote.host}/${remote.repo}:${branch}`, async () => {
    const r = tool === 'gh'
      ? await run('gh', ['pr', 'list', '--repo', remote.host === 'github.com' ? remote.repo : `${remote.host}/${remote.repo}`, '--head', branch, '--state', 'all', '--limit', '5', '--json', GH_FIELDS])
      : await run('glab', ['mr', 'list', '-R', `https://${remote.host}/${remote.repo}`, '--source-branch', branch, '--all', '-P', '5', '-F', 'json']);
    if (!r.json) return { problem: { tool, ...(r.missing ? { missing: true } : { error: r.error || 'unreadable answer' }) } };
    const list = (Array.isArray(r.json) ? r.json : []).map(tool === 'gh' ? normalizeGh : normalizeGlab).filter(Boolean);
    return { list };
  });
}

/**
 * The merge request whose source is `branch`, asked to each forge remote of the repo (a branch pushed to a fork has
 * its request in the upstream repo): `{ mr, problems }`. `mr` is null when there is none; `problems` lists the CLIs
 * missing or failing (not logged in…), once each.
 */
export async function mrOfBranch(root, branch, remotes) {
  const problems = [];
  if (!branch || branch === 'HEAD') return { mr: null, problems };
  for (const remote of remotes) {
    const r = await listOfBranch(remote, branch);
    if (r.problem) { if (!problems.some(p => p.tool === r.problem.tool)) problems.push(r.problem); continue; }
    const mr = pickMr(r.list);
    if (!mr) continue;
    // GitLab lists merge requests without their pipeline: read the one found in full
    const full = mr.forge === 'gitlab' ? await mrStatus(mr.url, remotes) : null;
    return { mr: { ...(full && !full.problem ? full : mr), remote: remote.name }, problems: [] };
  }
  return { mr: null, problems };
}

/**
 * One merge request by its URL: the common shape plus `remote` (name of the remote of this repo it belongs to, null
 * for another repository), or `{ url, forge, number, problem }` when it cannot be read.
 */
export async function mrStatus(url, remotes = []) {
  const ref = parseMrUrl(url);
  if (!ref) return null;
  const tool = ref.forge === 'github' ? 'gh' : 'glab';
  const remote = remotes.find(r => r.host === ref.host.toLowerCase() && r.repo.toLowerCase() === ref.repo.toLowerCase())?.name || null;
  const r = await cached(`mr:${ref.url}`, () => (tool === 'gh'
    ? run('gh', ['pr', 'view', ref.url, '--json', GH_FIELDS])
    : run('glab', ['mr', 'view', String(ref.number), '-R', `https://${ref.host}/${ref.repo}`, '-F', 'json'])));
  const mr = r.json && (tool === 'gh' ? normalizeGh(r.json) : normalizeGlab(r.json));
  if (!mr) return { forge: ref.forge, number: ref.number, url: ref.url, remote, problem: { tool, ...(r.missing ? { missing: true } : { error: r.error || 'unreadable answer' }) } };
  return { ...mr, url: ref.url, remote };
}
