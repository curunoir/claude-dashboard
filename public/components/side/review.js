// "Review" tab of the right panel: what the session produced, as one diff. Targets: the branch of the session (its
// folder against its base, uncommitted changes included) and its merge requests. Read only: one link opens the forge.
// Spec: docs/specs/2026-11-27-review-tab.md.
import { signal } from '../../core/signals.js';
import { detail, sideTab } from '../../core/state.js';
import { $, esc, skeleton } from '../../core/dom.js';
import { mrLabel, cleanMrUrls } from '../../core/mr-url.js';
import { readTargets, readRange } from '../../services/review.js';
import { openViewer } from '../editor/viewer.js';
import { pathMenu } from '../path-menu.js';
import { filesHtml } from '../git-files.js';
import { t } from '../../i18n/index.js';

/** Last reading for a session: `{ slug, target, targets, range }` (null before the first one). */
export const review = signal(null);

const chosen = new Map(); // slug -> target displayed ('branch' or a merge request URL)
let reading = null, lastRead = { key: '', at: 0 }, lastJson = '';

/** Merge requests known for the displayed session (count of the tab), 0 before the first reading. */
export function reviewCount(d) {
  const r = review();
  return r?.slug === d.slug && r.targets && !r.targets.notGit ? (r.targets.branchMr ? 1 : 0) + r.targets.mrs.length : 0;
}

/**
 * Reads the merge requests and the diff of the displayed target again (one reading at a time, at most one every 3 s
 * for the same session and target unless `force`); the tab repaints only when the answer changed.
 */
export function refreshReview(d, force = false) {
  const mrs = cleanMrUrls(d.mrs), target = chosen.get(d.slug) || 'branch';
  const key = `${d.slug}|${target}|${mrs.join(' ')}`;
  // Another target was just chosen while a reading runs: read again right after it
  if (reading && force) return reading.then(() => refreshReview(d, true));
  if (reading || (!force && key === lastRead.key && Date.now() - lastRead.at < 3000)) return reading;
  lastRead = { key, at: Date.now() };
  reading = Promise.all([
    readTargets(d.cwd, mrs).catch(e => ({ notGit: true, error: e.message })),
    readRange(d.cwd, target).catch(e => ({ error: e.message })),
  ]).then(([targets, range]) => {
    if ((chosen.get(d.slug) || 'branch') !== target) return; // answer for a target left in the meantime
    const next = { slug: d.slug, target, targets, range }, json = JSON.stringify(next);
    if (json !== lastJson) { lastJson = json; review.set(next); }
  }).finally(() => { reading = null; });
  return reading;
}

const pill = (cls, text) => `<span class="rv-pill ${cls}">${esc(text)}</span>`;
const statePills = mr => (mr.problem ? '' : pill(mr.state === 'open' && mr.draft ? 'draft' : mr.state, t(`side.review.state.${mr.state === 'open' && mr.draft ? 'draft' : mr.state}`))
  + (mr.ci ? pill(`ci-${mr.ci}`, t(`side.review.ci.${mr.ci}`)) : ''));

function problemsHtml(targets) {
  return (targets.problems || []).map(p => `<p class="m rv-problem">⚠ ${esc(p.missing ? t('side.review.toolMissing', { tool: p.tool }) : t('side.review.toolFailed', { tool: p.tool, message: p.error }))}</p>`).join('');
}

/** The targets, when there are several: the branch (with its merge request) then the other merge requests. */
function targetsHtml(targets, target) {
  if (!targets.mrs.length) return '';
  const item = (id, label, title, pills) => `<button class="rv-target ${id === target ? 'on' : ''}" data-review-target="${esc(id)}">
    <span class="rv-num">${esc(label)}</span><span class="rv-ttl">${esc(title)}</span>${pills}</button>`;
  const b = targets.branchMr;
  return `<div class="rv-targets">
    ${item('branch', b ? mrLabel(b) : '⎇', b ? b.title : targets.branch || t('side.review.detachedTitle'), b ? statePills(b) : pill('draft', t('side.review.noMr')))}
    ${targets.mrs.map(m => item(m.url, mrLabel(m), m.title || m.url, statePills(m) + (m.branch === targets.branch ? '' : pill('ref', t('side.review.cited'))))).join('')}
  </div>`;
}

function headHtml(targets, target, range) {
  const mr = target === 'branch' ? targets.branchMr : targets.mrs.find(m => m.url === target);
  const title = mr ? `${mrLabel(mr)} ${mr.title || ''}` : targets.branch ? t('side.review.branchTitle', { branch: targets.branch }) : t('side.review.detachedTitle');
  const files = range?.files || [];
  const plus = files.reduce((n, f) => n + (f.insertions || 0), 0), minus = files.reduce((n, f) => n + (f.deletions || 0), 0);
  const refs = range?.baseName ? `<span><code>${esc(range.headName || 'HEAD')}</code> ${mr ? '→' : t('side.review.comparedWith')} <code>${esc(range.baseName)}</code></span>` : '';
  const counts = range?.files ? `<span>${t('side.review.commits', { n: range.commits })} · ${t('side.review.files', { n: files.length })}
    ${plus ? `<span class="plus">+${plus}</span>` : ''} ${minus ? `<span class="minus">−${minus}</span>` : ''}</span>` : '';
  return `<div class="rv-head"><h2>${esc(title)}</h2>
    <div class="rv-meta">${mr ? statePills(mr) : pill('draft', t('side.review.noMr'))}${refs}${counts}
      ${mr ? `<a href="${esc(mr.url)}" target="_blank" rel="noopener">${t(`side.review.openOn.${mr.forge}`)}</a>` : ''}</div></div>`;
}

function bodyHtml(range, target) {
  if (!range) return skeleton('lines', 5);
  if (range.foreign) return `<p class="m">${t('side.review.foreign')}</p>`;
  if (range.noBase) return `<p class="m">${t('side.review.noBase')}</p>`;
  if (range.error || !range.files) return `<p class="m">${t('side.review.unreadable', { message: esc(range.error || '?') })}</p>`;
  if (!range.files.length) return `<p class="m">${t('side.review.nothing', { base: esc(range.baseName) })}</p>`;
  return `<div class="rv-section">${t('side.review.allFiles', { n: range.files.length })}${target === 'branch' ? ` <span class="m">· ${t('side.review.uncommitted')}</span>` : ''}</div>
    ${filesHtml(range.files, 'data-review-file')}`;
}

/**
 * Paints the tab for session `d` (tab bar `bar` on top) from the last reading. Called inside the effect of
 * `mountSide`, which reads `review` and calls `refreshReview`.
 */
export function renderReview(d, bar) {
  if (sideTab() !== 'review' || detail()?.slug !== d.slug) return;
  const el = $('#right'), r = review()?.slug === d.slug ? review() : null, scroll = el.scrollTop;
  el.classList.remove('mode-git');
  const targets = r?.targets;
  el.innerHTML = `${bar}<div id="review">${!targets ? skeleton('lines', 6)
    : targets.notGit ? `<p class="m">${t('side.review.notGit')}</p>`
    : problemsHtml(targets) + targetsHtml(targets, r.target) + headHtml(targets, r.target, r.range) + bodyHtml(r.range, r.target)}</div>`;
  el.scrollTop = scroll;
  el.querySelectorAll('[data-review-target]').forEach(b => b.addEventListener('click', () => {
    chosen.set(d.slug, b.dataset.reviewTarget);
    // The diff of the other target is not read yet: its header shows at once, the files as a skeleton
    review.set({ ...r, target: b.dataset.reviewTarget, range: null });
    refreshReview(d, true);
  }));
  const range = r?.range, files = range?.files || [];
  el.querySelectorAll('[data-review-file]').forEach(b => {
    const f = files[+b.dataset.i];
    b.addEventListener('click', () => openViewer(f.path, files.map(x => x.path), files.indexOf(f), {
      files, title: `${range.baseName} → ${range.headName || 'HEAD'}`,
      range: { base: range.mergeBase, head: range.head, baseName: range.baseName, headName: range.headName },
    }));
    b.addEventListener('contextmenu', e => { e.preventDefault(); pathMenu({ dataset: { path: f.path }, textContent: '' }, e.clientX, e.clientY); });
  });
}
