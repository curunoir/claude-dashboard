// Review of what a session produced (page server): its merge requests and the diff of a target.
import { api } from '../core/api.js';

/**
 * Merge requests of a folder: `{ root, branch, branchMr, mrs, problems }` (`branchMr`: the one of the current branch,
 * `mrs`: the others among the declared URLs, `problems`: forge CLIs missing or failing), or `{ notGit }`.
 */
export const readTargets = (dir, mrs = []) => api(`/api/review/targets?dir=${encodeURIComponent(dir)}&mrs=${encodeURIComponent(JSON.stringify(mrs))}`);

/**
 * Diff of a target (`branch`, or the URL of a merge request): `{ mergeBase, head, baseName, headName, commits,
 * fingerprint, files }`, or `{ noBase }`, `{ foreign }` (merge request of another repository), `{ error }`.
 */
export const readRange = (dir, target) => api(`/api/review/range?dir=${encodeURIComponent(dir)}&target=${encodeURIComponent(target)}`);
