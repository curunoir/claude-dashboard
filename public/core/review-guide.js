// Reading guide of a review (Review tab): the shape Claude sends through set_review_guide, checked here, and what the
// page derives from it. Pure, shared by the page and the engine. Spec: docs/specs/2026-11-27-review-tab.md.

export const ATTENTIONS = ['high', 'medium', 'low'];
const MAX_STEPS = 30, MAX_FILES = 80, MAX_ITEMS = 20;

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const texts = (v, max) => (Array.isArray(v) ? v.map(x => text(x, max)).filter(Boolean).slice(0, MAX_ITEMS) : []);

/** Path of the repo as git prints it (`a/b.js`), or null: absolute, with `..`, or empty. */
function relPath(v) {
  const p = text(v, 500).replace(/\\/g, '/').replace(/^\.\//, '');
  return !p || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').some(s => s === '..' || s === '') ? null : p;
}

/**
 * Line ranges of a file of the guide: `"40-95"`, `"12"`, `"40-95, 120-130"` give `[[40, 95], [12, 12]…]` (first
 * line 1, at most 10 ranges); anything else is dropped.
 */
export function lineRanges(v) {
  const ranges = [];
  for (const part of String(v ?? '').split(',')) {
    const m = part.trim().match(/^L?(\d{1,7})(?:\s*[-–]\s*L?(\d{1,7}))?$/i);
    if (!m) continue;
    const from = Number(m[1]), to = Number(m[2] || m[1]);
    if (from >= 1 && to >= from) ranges.push([from, to]);
  }
  return ranges.slice(0, 10);
}

/**
 * A guide as received, checked and trimmed: `{ guide }`, or `{ error }` (a sentence Claude can act on). Texts are
 * cut to a size the panel can show; a file is a path relative to the repo.
 */
export function cleanGuide(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'guide must be an object' };
  const summary = text(input.summary, 600);
  if (!summary) return { error: 'guide.summary is required (one or two sentences)' };
  const scope = input.scope && typeof input.scope === 'object' ? input.scope : {};
  if (!Array.isArray(input.steps) || !input.steps.length) return { error: 'guide.steps is required (at least one step)' };
  if (input.steps.length > MAX_STEPS) return { error: `guide.steps: ${MAX_STEPS} steps at most` };
  const steps = [];
  for (const [n, s] of input.steps.entries()) {
    const title = text(s?.title, 160);
    if (!title) return { error: `guide.steps[${n}].title is required` };
    if (!ATTENTIONS.includes(s.attention)) return { error: `guide.steps[${n}].attention must be one of ${ATTENTIONS.join(', ')}` };
    if (!Array.isArray(s.files) || !s.files.length) return { error: `guide.steps[${n}].files is required (at least one file)` };
    if (s.files.length > MAX_FILES) return { error: `guide.steps[${n}].files: ${MAX_FILES} files at most` };
    const files = [];
    for (const f of s.files) {
      const path = relPath(typeof f === 'string' ? f : f?.path);
      if (!path) return { error: `guide.steps[${n}].files: "${String(typeof f === 'string' ? f : f?.path).slice(0, 120)}" is not a path relative to the repository` };
      const ranges = lineRanges(f?.lines);
      files.push({ path, ...(ranges.length ? { lines: ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ') } : {}), ...(text(f?.note, 200) ? { note: text(f.note, 200) } : {}) });
    }
    steps.push({ title, attention: s.attention, why: text(s.why, 800), ...(text(s.check, 600) ? { check: text(s.check, 600) } : {}), files });
  }
  return {
    guide: {
      summary,
      scope: { asked: text(scope.asked, 600), done: text(scope.done, 600), extra: texts(scope.extra, 300), notDone: texts(scope.notDone, 300) },
      doubts: texts(input.doubts, 400),
      steps,
    },
  };
}

const COMMIT_ID = /^[0-9a-f]{7,40}$/i, STATES = ['modified', 'added', 'deleted', 'renamed', 'untracked'];

/**
 * The request for a guide as the page sends it (the diff it shows), checked before it goes into a message to Claude:
 * `{ target, dir, baseName, headName, mergeBase, head, fingerprint, files }`, or null. `dir` is the git folder of the
 * diff (the session may have worked in a worktree, not in its own folder); `target` is `branch` (the folder of the
 * session), `branch:<dir>` (another work folder) or a merge request URL already normalised (`isTarget`). Names are
 * single-line, ids are commit ids, 400 files at most.
 */
export function reviewRequest(body, isTarget = () => false) {
  const b = body && typeof body === 'object' ? body : {};
  const line = (v, max) => text(v, max).replace(/[\r\n\t`]+/g, ' ').trim();
  const dir = line(b.dir, 400).replace(/["'$]/g, '');
  if (!dir || dir !== b.dir) return null;
  if (b.target !== 'branch' && b.target !== `branch:${dir}` && !isTarget(b.target)) return null;
  if (!COMMIT_ID.test(b.mergeBase || '') || (b.head && !COMMIT_ID.test(b.head))) return null;
  if (!Array.isArray(b.files) || !b.files.length) return null;
  const files = [];
  for (const f of b.files.slice(0, 400)) {
    const rel = relPath(f?.rel);
    if (rel) files.push({ rel: line(rel, 300), state: STATES.includes(f.state) ? f.state : 'modified', insertions: Number(f.insertions) || 0, deletions: Number(f.deletions) || 0 });
  }
  if (!files.length) return null;
  return {
    target: b.target, dir, baseName: line(b.baseName, 200) || b.mergeBase, headName: line(b.headName, 200), mergeBase: b.mergeBase, head: b.head || '',
    fingerprint: /^[0-9a-f]{8,40}$/i.test(b.fingerprint || '') ? b.fingerprint : '', files,
  };
}

/**
 * The reading order of a diff with its guide: `{ steps, out, entries }`. `steps[k].files[j]` is the file of the diff
 * (`files`: `[{ rel, … }]`) with `lines` and `note`, or `{ rel, missing: true }` when the guide cites a file that is
 * no longer in the diff. `out`: the files of the diff the guide did not place. `entries`: the files in reading order
 * (`{ file, step }`, `step` -1 outside the path), a file cited by two steps being read twice.
 */
export function readingPath(files, guide) {
  const byRel = new Map(files.map(f => [f.rel, f])), placed = new Set(), entries = [];
  const steps = (guide?.steps || []).map((s, k) => ({
    ...s,
    files: s.files.map(g => {
      const f = byRel.get(g.path);
      if (!f) return { rel: g.path, missing: true, note: g.note };
      placed.add(f.rel);
      const file = { ...f, lines: g.lines, note: g.note, entry: entries.length };
      entries.push({ file, step: k });
      return file;
    }),
  }));
  const out = files.filter(f => !placed.has(f.rel)).map(f => {
    const file = { ...f, entry: entries.length };
    entries.push({ file, step: -1 });
    return file;
  });
  return { steps, out, entries };
}
