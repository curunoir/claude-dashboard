// Review routes: what a session produced, as one diff (its branch against its base, or a merge request), and the
// state of its merge requests. Read only. Spec: docs/specs/2026-11-27-review-tab.md.
import fs from 'node:fs';
import path from 'node:path';
import { sendJson } from '../../common.mjs';
import { isPathAllowed } from '../paths.mjs';
import { git, topLevel, reviewBase, gitRange, fetchMr } from '../git.mjs';
import { forgeRemotes, mrOfBranch, mrStatus } from '../forge.mjs';
import { cleanMrUrls, parseMrUrl } from '../../public/core/mr-url.js';
import { t } from '../../public/i18n/index.js';

/** Repo of the folder: root, current branch (empty when detached) and forge remotes. */
async function repoOf(dir) {
  const root = await topLevel(dir);
  const branch = (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();
  return { root, branch, remotes: await forgeRemotes(root) };
}

/** The folder of the request, checked: null (answer sent) when it is refused. */
async function folderOf(req, res, url) {
  const dir = path.resolve(url.searchParams.get('dir') || '');
  if (fs.existsSync(dir) && (await isPathAllowed(dir, req))) return dir;
  sendJson(res, 403, { error: t('server.errors.folderOutsideProjects') });
  return null;
}

export default {
  // The merge requests of a session: the one of its branch, and those it declared (`mrs`: JSON array of URLs)
  'GET /api/review/targets': async (req, res, { url }) => {
    const dir = await folderOf(req, res, url);
    if (!dir) return;
    try {
      let declared = [];
      try { declared = cleanMrUrls(JSON.parse(url.searchParams.get('mrs') || '[]'), 10); } catch { /* none */ }
      const { root, branch, remotes } = await repoOf(dir);
      const [ofBranch, others] = await Promise.all([mrOfBranch(root, branch, remotes), Promise.all(declared.map(u => mrStatus(u, remotes)))]);
      // A declared request of this very branch describes the branch too (the forge listing may have failed)
      const branchMr = ofBranch.mr || others.find(m => m.remote && branch && m.branch === branch && m.state === 'open') || null;
      const problems = [...ofBranch.problems];
      for (const m of others) if (m.problem && !problems.some(p => p.tool === m.problem.tool)) problems.push(m.problem);
      return sendJson(res, 200, { root: path.normalize(root), branch, branchMr, mrs: others.filter(m => m.url !== branchMr?.url), problems });
    } catch (e) { return sendJson(res, 200, { notGit: true, error: e.message }); }
  },
  // The diff of a target: `branch` (the folder against the base of its branch) or the URL of a merge request of this
  // repo. The refs are chosen here: the page never sends a ref name.
  'GET /api/review/range': async (req, res, { url }) => {
    const dir = await folderOf(req, res, url);
    if (!dir) return;
    try {
      const target = url.searchParams.get('target') || 'branch';
      const { root, branch, remotes } = await repoOf(dir);
      if (target === 'branch') {
        const { mr } = await mrOfBranch(root, branch, remotes);
        const base = await reviewBase(root, { wanted: mr?.base, remote: mr?.remote, branch });
        if (!base) return sendJson(res, 200, { noBase: true });
        return sendJson(res, 200, { ...(await gitRange(dir, { base: base.sha })), baseName: base.name, headName: branch });
      }
      if (!parseMrUrl(target)) return sendJson(res, 400, { error: t('server.review.invalidTarget') });
      const mr = await mrStatus(target, remotes);
      if (mr.problem) return sendJson(res, 200, { error: mr.problem.error || t('server.review.toolMissing', { tool: mr.problem.tool }) });
      if (!mr.remote) return sendJson(res, 200, { foreign: true });
      const head = await fetchMr(root, mr);
      const base = await reviewBase(root, { wanted: mr.base, remote: mr.remote });
      if (!head || !base) return sendJson(res, 200, { noBase: true });
      return sendJson(res, 200, { ...(await gitRange(dir, { base: base.sha, head })), baseName: base.name, headName: mr.branch });
    } catch (e) { return sendJson(res, 200, { notGit: true, error: e.message }); }
  },
};
