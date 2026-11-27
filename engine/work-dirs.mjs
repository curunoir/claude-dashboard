// Where a session really worked: the git folders (repository or worktree roots) of the files it edited. A session
// started in a repo often creates a worktree and works there: the Review tab follows these folders, not only its
// starting folder. Kept in the session JSON as `workDirs`, most recent first.
import fs from 'node:fs';
import path from 'node:path';
import { topLevel } from '../server/git.mjs';
import { pathKey } from '../public/core/path-key.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const MAX_WORK_DIRS = 8;

/** The file a tool call writes (absolute path), otherwise null. Pure. */
export function editedFile(name, input) {
  if (!EDIT_TOOLS.has(name)) return null;
  const p = input?.file_path || input?.notebook_path;
  return typeof p === 'string' && path.isAbsolute(p) ? p : null;
}

/** `dir` put first in the list (each folder once, by path key, `MAX_WORK_DIRS` at most). Pure. */
export function withWorkDir(list, dir) {
  const rest = (Array.isArray(list) ? list : []).filter(d => typeof d === 'string' && pathKey(d) !== pathKey(dir));
  return [dir, ...rest].slice(0, MAX_WORK_DIRS);
}

const roots = new Map(); // folder of a file (path key) -> promise of its git root, or null outside git
/** Git root of a file (which may not exist yet, or no longer): asked to git once per folder. */
export function rootOfFile(file) {
  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const key = pathKey(dir);
  if (!roots.has(key)) {
    if (roots.size > 2000) roots.clear();
    roots.set(key, topLevel(dir).then(r => path.normalize(r), () => null));
  }
  return roots.get(key);
}

/** Work folders of a feed (live, or rebuilt from the history): those of the files its tool calls wrote, most recent first. */
export async function workDirsOfFeed(feed) {
  let dirs = [];
  for (const ev of Array.isArray(feed) ? feed : []) {
    const file = ev?.t === 'tool' ? editedFile(ev.name, ev.input) : null;
    const root = file && await rootOfFile(file);
    if (root) dirs = withWorkDir(dirs, root);
  }
  return dirs;
}
