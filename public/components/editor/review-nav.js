// Reading path of a review inside the editor (viewer.js, option `guide`): the steps on the left in place of the file
// list, the current step recalled above the diff, its lines marked, and the navigation that follows the path.
// `guide`: `{ path, isRead(step), toggleRead(step) }`, `path` from readingPath() (public/core/review-guide.js).
import { esc } from '../../core/dom.js';
import { GIT_STATES } from '../../services/git.js';
import { lineRanges } from '../../core/review-guide.js';
import { t } from '../../i18n/index.js';

const fileRow = (f, i) => {
  if (f.missing) return '';
  const [letter] = GIT_STATES[f.state] || ['M'];
  return `<button class="git-file rv-nav-file e-${esc(f.state)} ${f.entry === i ? 'sel' : ''}" data-vis-list data-i="${f.entry}" title="${esc(f.rel)}${f.note ? ` · ${esc(f.note)}` : ''}">
    <span class="letter">${letter}</span><span class="name">${esc(f.rel.split('/').pop())}</span>${f.lines ? `<span class="rv-lines">L${esc(f.lines)}</span>` : ''}</button>`;
};

/** Left panel: the steps (the current one marked, the read ones ticked) with their files, then the files outside the path. */
export function navHtml(guide, i) {
  const { path } = guide, current = path.entries[i]?.step;
  const done = path.steps.filter((_, k) => guide.isRead(k)).length;
  return `<div class="m vis-list-head">${t('side.review.guide.path')} · ${t('side.review.guide.progress', { done, n: path.steps.length })}</div>
    <div class="vis-scroll">${path.steps.map((s, k) => `<div class="rv-nav-step ${esc(s.attention)} ${k === current ? 'cur' : ''} ${guide.isRead(k) ? 'done' : ''}">
      <div class="rv-nav-title"><span class="n">${k + 1}</span><span class="t">${esc(s.title)}</span>${guide.isRead(k) ? '<span class="ok">✓</span>' : ''}</div>
      ${s.files.map(f => fileRow(f, i)).join('')}</div>`).join('')}
    ${path.out.length ? `<div class="rv-nav-step out ${current === -1 ? 'cur' : ''}"><div class="rv-nav-title" title="${t('side.review.guide.outTitle')}"><span class="t">${t('side.review.guide.out', { n: path.out.length })}</span></div>
      ${path.out.map(f => fileRow(f, i)).join('')}</div>` : ''}</div>`;
}

/** Above the diff: the step of the open file (why, what to check), or nothing for a file outside the path. */
export function bannerHtml(guide, i) {
  const e = guide.path.entries[i], s = guide.path.steps[e?.step];
  if (!s) return '';
  const inStep = s.files.filter(f => !f.missing), rank = inStep.findIndex(f => f.entry === i) + 1;
  return `<div class="rv-banner ${esc(s.attention)}">
    <div class="top"><b>${t('side.review.guide.stepTitle', { n: e.step + 1, title: esc(s.title) })}</b>
      <span class="rv-att ${esc(s.attention)}">${t(`side.review.guide.attention.${s.attention}`)}</span><span class="m">${t('side.review.guide.fileRank', { i: rank, n: inStep.length })}</span></div>
    ${s.why ? `<p>${esc(s.why)}</p>` : ''}${s.check ? `<p class="rv-look">${t('side.review.guide.check', { text: esc(s.check) })}</p>` : ''}
    ${e.file.note ? `<p class="m">${esc(e.file.note)}${e.file.lines ? ` · L${esc(e.file.lines)}` : ''}</p>` : ''}</div>`;
}

/** Under the diff: previous / next file of the path, and the step ticked read (which moves on to the next step). */
export function footHtml(guide, i) {
  const { path } = guide, e = path.entries[i], last = i === path.entries.length - 1;
  const lastOfStep = e.step >= 0 && path.entries[i + 1]?.step !== e.step;
  const read = e.step >= 0 && guide.isRead(e.step);
  return `<div class="rv-foot">
    <button class="btn" data-vis="prev" ${i ? '' : 'disabled'}>← ${t('side.review.guide.previous')}</button>
    <span class="m">${t('side.review.guide.keys')}</span><span class="sp"></span>
    ${last ? '' : `<button class="btn" data-vis="next">${t(lastOfStep ? 'side.review.guide.nextStep' : 'side.review.guide.nextFile')} →</button>`}
    ${e.step < 0 ? '' : `<button class="btn ${read ? '' : 'primary'}" data-vis="step-read">${read ? t('side.review.guide.unread') : t('side.review.guide.markRead')}</button>`}</div>`;
}

/** Entry to show after the step of entry `i` was ticked read: the first file of the next step, or `i` (last step). */
export function afterStep(guide, i) {
  const { entries } = guide.path, step = entries[i].step;
  const next = entries.findIndex((e, k) => k > i && e.step !== step);
  return next < 0 ? i : next;
}

/** Marks the lines of the open file that the step is about (a red rule in the margin) and shows the first one. */
export function markLines(monaco, editor, guide, i) {
  const ranges = lineRanges(guide.path.entries[i]?.file.lines);
  if (!ranges.length) return;
  const ed = editor.getModifiedEditor ? editor.getModifiedEditor() : editor, last = ed.getModel()?.getLineCount() || 1;
  setTimeout(() => {
    ed.deltaDecorations([], ranges.filter(([a]) => a <= last).map(([a, b]) => ({
      range: new monaco.Range(a, 1, Math.min(b, last), 1), options: { isWholeLine: true, linesDecorationsClassName: 'rv-line-mark' },
    })));
    ed.revealLineNearTop(Math.min(ranges[0][0], last));
  }, 80);
}
