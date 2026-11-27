// "Review" tab of the right panel: what the session produced, as one diff. Targets: the branch of the session (its
// folder against its base, uncommitted changes included) and its merge requests. On request, Claude writes a reading
// guide of the target (in short, doubts, reading path). Read only: one link opens the forge.
// Spec: docs/specs/2026-11-27-review-tab.md.
import { signal } from '../../core/signals.js';
import { detail, sideTab } from '../../core/state.js';
import { $, esc, skeleton } from '../../core/dom.js';
import { read, write } from '../../core/storage.js';
import { mrLabel, cleanMrUrls } from '../../core/mr-url.js';
import { readingPath } from '../../core/review-guide.js';
import { readTargets, readRange, requestGuide } from '../../services/review.js';
import { GIT_STATES } from '../../services/git.js';
import { openViewer } from '../editor/viewer.js';
import { pathMenu } from '../path-menu.js';
import { filesHtml } from '../git-files.js';
import { t } from '../../i18n/index.js';

/** Last reading for a session: `{ slug, target, targets, range }` (null before the first one). */
export const review = signal(null);

const chosen = new Map();   // slug -> target displayed ('branch' or a merge request URL)
const asking = new Map();   // slug -> { target, at }: guide asked, not received yet
const unfolded = new Map(); // `slug|target|step` -> true / false: a step opened or folded by hand
let reading = null, lastRead = { key: '', at: 0 }, lastJson = '';

/** Merge requests known for the displayed session (count of the tab), 0 before the first reading. */
export function reviewCount(d) {
  const r = review();
  return r?.slug === d.slug && r.targets && !r.targets.notGit ? (r.targets.branchMr ? 1 : 0) + r.targets.mrs.length : 0;
}

/**
 * Reads the merge requests and the diff of the displayed target again (one reading at a time, at most one every 8 s
 * for the same session and target unless `force`); the tab repaints only when the answer changed.
 */
export function refreshReview(d, force = false) {
  const mrs = cleanMrUrls(d.mrs), target = chosen.get(d.slug) || 'branch';
  const key = `${d.slug}|${target}|${mrs.join(' ')}`;
  // Another target was just chosen while a reading runs: read again right after it
  if (reading && force) return reading.then(() => refreshReview(d, true));
  if (reading || (!force && key === lastRead.key && Date.now() - lastRead.at < 8000)) return reading;
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

// --- Steps read: kept in the browser, per session and target, for one version of the guide -------------------------

const readKey = slug => `dash-review-read-${slug}`;
/** Steps of this guide ticked "read" (their indexes). A guide written again starts from scratch. */
export function readSteps(slug, target, guide) {
  const saved = read(readKey(slug), {})[target];
  return new Set(saved?.at === guide.createdAt ? saved.steps : []);
}
/** Ticks or unticks a step, then repaints the tab. Returns whether it is now read. */
export function toggleRead(slug, target, guide, step) {
  const steps = readSteps(slug, target, guide);
  if (!steps.delete(step)) steps.add(step);
  write(readKey(slug), { ...read(readKey(slug), {}), [target]: { at: guide.createdAt, steps: [...steps] } });
  if (review()) review.set({ ...review() });
  return steps.has(step);
}

// --- Rendering ------------------------------------------------------------------------------------------------------

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

/** A file of the reading path: its lines and the note of the guide; `entry` is its rank in the reading order. */
function pathFile(f) {
  if (f.missing) return `<div class="rv-file gone" title="${t('side.review.goneTitle')}"><span class="letter">·</span><span class="name">${esc(f.rel)}</span></div>`;
  const [letter] = GIT_STATES[f.state] || ['M'];
  const name = f.rel.split('/').pop(), folder = f.rel.slice(0, -name.length);
  return `<button class="git-file rv-file e-${esc(f.state)}" data-review-entry="${f.entry}" title="${esc(f.rel)}">
    <span class="letter">${letter}</span><span class="name"><b>${esc(name)}</b>${f.lines ? ` <span class="rv-lines">L${esc(f.lines)}</span>` : ''} <span class="m">${esc(f.note || folder)}</span></span>
    <span class="lines">${f.binary ? '' : `${f.insertions ? `<span class="plus">+${f.insertions}</span>` : ''}${f.deletions ? ` <span class="minus">−${f.deletions}</span>` : ''}`}</span></button>`;
}

const isPending = (d, target, guide) => {
  const a = asking.get(d.slug);
  return !!a && a.target === target && Date.now() - a.at < 15 * 60_000 && (!guide || Date.parse(guide.createdAt) < a.at);
};

function guideHtml(d, target, range, guide, path) {
  const pending = isPending(d, target, guide);
  const askButton = label => `<button class="btn ${guide ? '' : 'primary'}" data-review-ask ${pending ? 'disabled' : ''}>${pending ? t('side.review.guide.pending') : label}</button>`;
  if (!guide) return `<div class="rv-empty"><p>${t('side.review.guide.offer')}</p>${askButton(t('side.review.guide.ask'))}</div>`;
  const done = readSteps(d.slug, target, guide);
  const stale = guide.fingerprint && range.fingerprint && guide.fingerprint !== range.fingerprint;
  const list = (items, cls = '') => items.map(x => `<span class="${cls}">${esc(x)}</span>`).join('<br>');
  const scope = guide.scope || {};
  const rows = [['asked', scope.asked && esc(scope.asked), ''], ['done', scope.done && esc(scope.done), ''],
    ['extra', scope.extra?.length && list(scope.extra), 'extra'], ['notDone', scope.notDone?.length && list(scope.notDone), '']].filter(r => r[1]);
  const steps = path.steps.map((s, k) => {
    const isRead = done.has(k), files = s.files.filter(f => !f.missing).length;
    const open = unfolded.get(`${d.slug}|${target}|${k}`) ?? (!isRead && s.attention !== 'low');
    return `<div class="rv-step ${esc(s.attention)} ${isRead ? 'done' : ''}">
      <div class="rv-step-head" data-review-step="${k}"><span class="n">${k + 1}</span><span class="t">${esc(s.title)}</span>
        <span class="rv-att ${esc(s.attention)}">${t(`side.review.guide.attention.${s.attention}`)}${open ? '' : ` · ${t('side.review.files', { n: files })}`}</span>
        <button class="rv-check" data-review-read="${k}" title="${t(isRead ? 'side.review.guide.unreadTitle' : 'side.review.guide.readTitle')}">${isRead ? '✓' : ''}</button></div>
      ${open ? `<div class="rv-step-body">${s.why ? `<p class="rv-why">${esc(s.why)}</p>` : ''}
        ${s.check ? `<p class="rv-look">${t('side.review.guide.check', { text: esc(s.check) })}</p>` : ''}${s.files.map(pathFile).join('')}</div>` : ''}
    </div>`;
  }).join('');
  return `${stale ? `<div class="rv-stale"><span>⚠ ${t('side.review.guide.stale')}</span><span class="sp"></span>${askButton(t('side.review.guide.update'))}</div>` : ''}
    <div class="rv-section">${t('side.review.guide.inShort')}${stale ? '' : `<span class="sp"></span>${pending ? `<span class="m">${t('side.review.guide.pending')}</span>` : `<button class="rv-redo" data-review-ask title="${t('side.review.guide.redoTitle')}">↻</button>`}`}</div>
    <p class="rv-summary">${esc(guide.summary)}</p>
    ${rows.length ? `<dl class="rv-scope">${rows.map(([k, html, cls]) => `<dt class="${cls}">${t(`side.review.guide.scope.${k}`)}</dt><dd class="${cls}">${html}</dd>`).join('')}</dl>` : ''}
    ${guide.doubts?.length ? `<ul class="rv-doubts">${guide.doubts.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="rv-section">${t('side.review.guide.path')}<span class="sp"></span><span class="m">${t('side.review.guide.progress', { done: done.size, n: path.steps.length })}</span>
      <span class="rv-progress"><i style="width:${Math.round((done.size * 100) / path.steps.length)}%"></i></span></div>
    ${steps}
    ${path.out.length ? `<div class="rv-section" title="${t('side.review.guide.outTitle')}">${t('side.review.guide.out', { n: path.out.length })}</div>${path.out.map(pathFile).join('')}` : ''}`;
}

function bodyHtml(d, target, range, guide, path) {
  if (!range) return skeleton('lines', 5);
  if (range.foreign) return `<p class="m">${t('side.review.foreign')}</p>`;
  if (range.noBase) return `<p class="m">${t('side.review.noBase')}</p>`;
  if (range.error || !range.files) return `<p class="m">${t('side.review.unreadable', { message: esc(range.error || '?') })}</p>`;
  if (!range.files.length) return `<p class="m">${t('side.review.nothing', { base: esc(range.baseName) })}</p>`;
  const uncommitted = target === 'branch' ? ` <span class="m">· ${t('side.review.uncommitted')}</span>` : '';
  // With a guide, every file is in the reading path or under "Outside the path": the flat list would repeat them
  return guideHtml(d, target, range, guide, path) + (guide ? '' : `<div class="rv-section">${t('side.review.allFiles', { n: range.files.length })}${uncommitted}</div>
    ${filesHtml(range.files, 'data-review-file')}`);
}

/**
 * Paints the tab for session `d` (tab bar `bar` on top) from the last reading. Called inside the effect of
 * `mountSide`, which reads `review` and calls `refreshReview`.
 */
export function renderReview(d, bar) {
  if (sideTab() !== 'review' || detail()?.slug !== d.slug) return;
  const el = $('#right'), r = review()?.slug === d.slug ? review() : null, scroll = el.scrollTop;
  el.classList.remove('mode-git');
  const targets = r?.targets, range = r?.range, files = range?.files || [];
  const guide = r && files.length ? d.reviews?.[r.target] || null : null;
  const path = guide ? readingPath(files, guide) : null;
  el.innerHTML = `${bar}<div id="review">${!targets ? skeleton('lines', 6)
    : targets.notGit ? `<p class="m">${t('side.review.notGit')}</p>`
    : problemsHtml(targets) + targetsHtml(targets, r.target) + headHtml(targets, r.target, range) + bodyHtml(d, r.target, range, guide, path)}</div>`;
  el.scrollTop = scroll;
  const repaint = () => review.set({ ...review() });
  el.querySelectorAll('[data-review-target]').forEach(b => b.addEventListener('click', () => {
    chosen.set(d.slug, b.dataset.reviewTarget);
    // The diff of the other target is not read yet: its header shows at once, the files as a skeleton
    review.set({ ...r, target: b.dataset.reviewTarget, range: null });
    refreshReview(d, true);
  }));
  const viewerOptions = { title: `${range?.baseName} → ${range?.headName || 'HEAD'}`, range: range && { base: range.mergeBase, head: range.head, baseName: range.baseName, headName: range.headName } };
  const menu = (b, f) => b.addEventListener('contextmenu', e => { e.preventDefault(); pathMenu({ dataset: { path: f.path }, textContent: '' }, e.clientX, e.clientY); });
  // Without a guide: the files of the diff, in their order
  el.querySelectorAll('[data-review-file]').forEach(b => {
    const f = files[+b.dataset.i];
    b.addEventListener('click', () => openViewer(f.path, files.map(x => x.path), files.indexOf(f), { ...viewerOptions, files }));
    menu(b, f);
  });
  // With a guide: the editor follows the reading path (steps, then the files outside it)
  el.querySelectorAll('[data-review-entry]').forEach(b => {
    const n = +b.dataset.reviewEntry, f = path.entries[n].file;
    b.addEventListener('click', () => openViewer(f.path, path.entries.map(e => e.file.path), n, {
      ...viewerOptions, files,
      guide: { path, isRead: k => readSteps(d.slug, r.target, guide).has(k), toggleRead: k => toggleRead(d.slug, r.target, guide, k) },
    }));
    menu(b, f);
  });
  el.querySelectorAll('[data-review-read]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    unfolded.delete(`${d.slug}|${r.target}|${b.dataset.reviewRead}`); // back to the default: a read step folds
    toggleRead(d.slug, r.target, guide, +b.dataset.reviewRead);
  }));
  el.querySelectorAll('[data-review-step]').forEach(h => h.addEventListener('click', () => {
    const key = `${d.slug}|${r.target}|${h.dataset.reviewStep}`;
    unfolded.set(key, !h.parentElement.querySelector('.rv-step-body'));
    repaint();
  }));
  el.querySelectorAll('[data-review-ask]').forEach(b => b.addEventListener('click', async () => {
    asking.set(d.slug, { target: r.target, at: Date.now() });
    repaint();
    try {
      await requestGuide(d.slug, {
        target: r.target, baseName: range.baseName, headName: range.headName, mergeBase: range.mergeBase, head: range.head, fingerprint: range.fingerprint,
        files: files.map(f => ({ rel: f.rel, state: f.state, insertions: f.insertions, deletions: f.deletions })),
      });
    } catch (e) { asking.delete(d.slug); repaint(); alert(t('side.review.guide.askFailed', { message: e.message })); }
  }));
}
