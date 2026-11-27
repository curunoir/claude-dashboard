// Review tab: merge request URLs, forge answers in the common shape, files of a diff range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMrUrl, mrUrlsIn, cleanMrUrls, mrLabel } from '../public/core/mr-url.js';
import { remoteRepo, toolOf, normalizeGh, normalizeGlab, pickMr } from '../server/forge.mjs';
import { parseRangeFiles } from '../server/git.mjs';
import { boardFields } from '../engine/board-fields.mjs';
import { createsMr } from '../driver/events.mjs';

test('parseMrUrl: GitHub pull requests and GitLab merge requests, whatever the host', () => {
  assert.deepEqual(parseMrUrl('https://github.com/acme/app/pull/12/files#diff-1'), { forge: 'github', host: 'github.com', repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12' });
  assert.deepEqual(parseMrUrl(' https://git.example.com/team/sub/app/-/merge_requests/2691/diffs?x=1 '),
    { forge: 'gitlab', host: 'git.example.com', repo: 'team/sub/app', number: 2691, url: 'https://git.example.com/team/sub/app/-/merge_requests/2691' });
  for (const bad of ['https://github.com/acme/app/issues/12', 'https://github.com/acme/pull/12', 'javascript:alert(1)', 'file:///c/x/pull/1', '', null, 'https://git.example.com/team/app/-/merge_requests/new'])
    assert.equal(parseMrUrl(bad), null, String(bad));
});

test('mrUrlsIn and cleanMrUrls: each request once, anything else dropped', () => {
  const out = 'Creating merge request for x into develop\n\n!12 Title (x)\n https://gitlab.com/g/p/-/merge_requests/12\nremote: see https://gitlab.com/g/p/-/merge_requests/12/diffs.';
  assert.deepEqual(mrUrlsIn(out), ['https://gitlab.com/g/p/-/merge_requests/12']);
  assert.deepEqual(mrUrlsIn('https://example.com and (https://github.com/a/b/pull/3)'), ['https://github.com/a/b/pull/3']);
  assert.deepEqual(cleanMrUrls(['https://github.com/a/b/pull/3/files', 'https://github.com/a/b/pull/3', 'x', 4, null]), ['https://github.com/a/b/pull/3']);
  assert.deepEqual(cleanMrUrls('https://github.com/a/b/pull/3'), []);
  assert.equal(cleanMrUrls(Array.from({ length: 30 }, (_, i) => `https://github.com/a/b/pull/${i + 1}`)).length, 20);
  assert.equal(mrLabel({ forge: 'gitlab', number: 7 }), '!7');
  assert.equal(mrLabel({ forge: 'github', number: 7 }), '#7');
});

test('remoteRepo and toolOf', () => {
  assert.deepEqual(remoteRepo('https://github.com/Acme/app.git'), { host: 'github.com', repo: 'Acme/app' });
  assert.deepEqual(remoteRepo('git@git.example.com:team/sub/app.git'), { host: 'git.example.com', repo: 'team/sub/app' });
  assert.deepEqual(remoteRepo('ssh://git@git.example.com:2222/team/app'), { host: 'git.example.com', repo: 'team/app' });
  assert.deepEqual(remoteRepo('https://user:pw@gitlab.com/team/app.git/'), { host: 'gitlab.com', repo: 'team/app' });
  for (const local of ['C:\\repos\\app', 'C:/repos/app', '/srv/git/app.git', '../app', ''])
    assert.equal(remoteRepo(local), null, local);
  assert.equal(toolOf('github.com'), 'gh');
  assert.equal(toolOf('git.example.com'), 'glab');
  assert.equal(toolOf('notgithub.com'), 'glab');
});

test('normalizeGh: state, draft and CI from the checks', () => {
  const pr = { number: 3, title: 'T', state: 'OPEN', isDraft: true, url: 'https://github.com/a/b/pull/3', baseRefName: 'main', headRefName: 'fix', headRefOid: 'abc', statusCheckRollup: [] };
  assert.deepEqual(normalizeGh(pr), { forge: 'github', number: 3, title: 'T', url: pr.url, state: 'open', draft: true, base: 'main', branch: 'fix', head: 'abc', ci: null });
  const ci = checks => normalizeGh({ ...pr, statusCheckRollup: checks }).ci;
  assert.equal(ci([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]), 'success');
  assert.equal(ci([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'running');
  assert.equal(ci([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }]), 'failed');
  assert.equal(ci([{ state: 'PENDING' }]), 'running');
  assert.equal(normalizeGh({ ...pr, state: 'MERGED' }).state, 'merged');
  assert.equal(normalizeGh({ ...pr, state: 'CLOSED' }).state, 'closed');
  assert.equal(normalizeGh({}), null);
});

test('normalizeGlab: state, draft and pipeline', () => {
  const mr = { iid: 2691, title: 'T', state: 'opened', draft: false, web_url: 'https://gitlab.com/g/p/-/merge_requests/2691', target_branch: 'develop', source_branch: 'x', sha: 'abc', head_pipeline: { status: 'failed' } };
  assert.deepEqual(normalizeGlab(mr), { forge: 'gitlab', number: 2691, title: 'T', url: mr.web_url, state: 'open', draft: false, base: 'develop', branch: 'x', head: 'abc', ci: 'failed' });
  assert.equal(normalizeGlab({ ...mr, head_pipeline: null, pipeline: { status: 'running' } }).ci, 'running');
  assert.equal(normalizeGlab({ ...mr, head_pipeline: { status: 'success' } }).ci, 'success');
  assert.equal(normalizeGlab({ ...mr, head_pipeline: null }).ci, null);
  assert.equal(normalizeGlab({ ...mr, state: 'merged' }).state, 'merged');
  assert.equal(normalizeGlab({ ...mr, draft: undefined, work_in_progress: true }).draft, true);
  assert.equal(normalizeGlab(null), null);
});

test('pickMr: the open request of a branch before an older merged one', () => {
  assert.equal(pickMr([{ number: 1, state: 'merged' }, { number: 2, state: 'open' }]).number, 2);
  assert.equal(pickMr([{ number: 5, state: 'closed' }, { number: 4, state: 'merged' }]).number, 5);
  assert.equal(pickMr([]), null);
});

test('parseRangeFiles: states, lines, renames and binaries', () => {
  const nameStatus = ['M', 'server/git.mjs', 'A', 'server/forge.mjs', 'D', 'old.txt', 'R087', 'a/before.js', 'b/after.js', 'M', 'logo.png', ''].join('\0');
  const numstat = ['10\t2\tserver/git.mjs', '84\t0\tserver/forge.mjs', '0\t7\told.txt', '3\t1\t', 'a/before.js', 'b/after.js', '-\t-\tlogo.png', ''].join('\0');
  assert.deepEqual(parseRangeFiles(nameStatus, numstat), [
    { rel: 'server/git.mjs', state: 'modified', insertions: 10, deletions: 2, binary: false },
    { rel: 'server/forge.mjs', state: 'added', insertions: 84, deletions: 0, binary: false },
    { rel: 'old.txt', state: 'deleted', insertions: 0, deletions: 7, binary: false },
    { rel: 'b/after.js', state: 'renamed', from: 'a/before.js', insertions: 3, deletions: 1, binary: false },
    { rel: 'logo.png', state: 'modified', insertions: 0, deletions: 0, binary: true },
  ]);
  assert.deepEqual(parseRangeFiles('', ''), []);
});

test('boardFields: mrs only as merge request URLs', () => {
  assert.deepEqual(boardFields({ mrs: ['https://github.com/a/b/pull/3/files', 'javascript:alert(1)'] }).fields, { mrs: ['https://github.com/a/b/pull/3'] });
  assert.deepEqual(boardFields({ mrs: ['https://example.com'] }), { fields: {}, ignored: ['mrs'] });
  assert.deepEqual(boardFields({ mrs: 'https://github.com/a/b/pull/3' }), { fields: {}, ignored: ['mrs'] });
  assert.deepEqual(boardFields({ mrs: null }).fields, { mrs: null });
  assert.deepEqual(boardFields({ reviews: {} }), { fields: {}, ignored: ['reviews'] });
});

test('createsMr: the commands whose output gives a merge request URL', () => {
  assert.ok(createsMr('glab mr create --fill --target-branch develop'));
  assert.ok(createsMr('git push -u origin x && gh pr create --title "T" --body "B"'));
  assert.ok(createsMr('cd repo; gh.exe pr create'));
  assert.ok(!createsMr('gh pr view 3'));
  assert.ok(!createsMr('mygh pr create'));
});

test('lineRanges: ranges of a file of the guide', async () => {
  const { lineRanges } = await import('../public/core/review-guide.js');
  assert.deepEqual(lineRanges('40-95'), [[40, 95]]);
  assert.deepEqual(lineRanges('L12, 40 - 95,x, 9-3, 0'), [[12, 12], [40, 95]]);
  assert.deepEqual(lineRanges(undefined), []);
});

test('cleanGuide: checked, trimmed, refused with a reason', async () => {
  const { cleanGuide } = await import('../public/core/review-guide.js');
  const step = { title: 'Core', attention: 'high', why: 'w', check: 'c', files: [{ path: 'server\\git.mjs', lines: '40-95, 3', note: 'gitRange()' }, 'tests/a.test.mjs'] };
  const { guide } = cleanGuide({ summary: ' S ', scope: { asked: 'a', done: 'd', extra: ['x', '', 3], notDone: 'no' }, doubts: ['d1'], steps: [step], other: 1 });
  assert.deepEqual(guide, {
    summary: 'S', scope: { asked: 'a', done: 'd', extra: ['x'], notDone: [] }, doubts: ['d1'],
    steps: [{ title: 'Core', attention: 'high', why: 'w', check: 'c', files: [{ path: 'server/git.mjs', lines: '40-95, 3', note: 'gitRange()' }, { path: 'tests/a.test.mjs' }] }],
  });
  const bad = (g, part) => assert.match(cleanGuide(g).error, part);
  bad(null, /object/);
  bad({ steps: [step] }, /summary/);
  bad({ summary: 's', steps: [] }, /steps/);
  bad({ summary: 's', steps: [{ ...step, attention: 'huge' }] }, /attention/);
  bad({ summary: 's', steps: [{ ...step, files: [] }] }, /files/);
  for (const path of ['../x', '/etc/passwd', 'C:\\x\\y', 'a//b', ''])
    bad({ summary: 's', steps: [{ ...step, files: [{ path }] }] }, /not a path relative/);
});

test('readingPath: steps in order, files outside the path, files gone from the diff', async () => {
  const { readingPath } = await import('../public/core/review-guide.js');
  const files = ['a.js', 'b.js', 'c.js', 'd.js'].map(rel => ({ rel, path: `/r/${rel}`, state: 'modified' }));
  const guide = { steps: [
    { title: '1', attention: 'high', files: [{ path: 'b.js', lines: '3-9' }, { path: 'gone.js' }] },
    { title: '2', attention: 'low', files: [{ path: 'a.js' }, { path: 'b.js', lines: '40' }] },
  ] };
  const p = readingPath(files, guide);
  assert.deepEqual(p.entries.map(e => [e.file.rel, e.step, e.file.lines]), [['b.js', 0, '3-9'], ['a.js', 1, undefined], ['b.js', 1, '40'], ['c.js', -1, undefined], ['d.js', -1, undefined]]);
  assert.deepEqual(p.steps[0].files.map(f => [f.rel, f.missing, f.entry]), [['b.js', undefined, 0], ['gone.js', true, undefined]]);
  assert.deepEqual(p.out.map(f => [f.rel, f.entry]), [['c.js', 3], ['d.js', 4]]);
  assert.deepEqual(readingPath(files, null).out.length, 4);
});

test('reviewRequest: only a checked diff goes into the message to Claude', async () => {
  const { reviewRequest } = await import('../public/core/review-guide.js');
  const ok = { target: 'branch', baseName: 'origin/main', headName: 'x\n`rm`', mergeBase: 'a'.repeat(40), head: '', fingerprint: 'abcdef0123456789', files: [{ rel: 'a.js', state: 'added', insertions: 3, deletions: 0 }, { rel: '../b', state: 'x' }] };
  assert.deepEqual(reviewRequest(ok), { target: 'branch', baseName: 'origin/main', headName: 'x rm', mergeBase: 'a'.repeat(40), head: '', fingerprint: 'abcdef0123456789', files: [{ rel: 'a.js', state: 'added', insertions: 3, deletions: 0 }] });
  assert.equal(reviewRequest({ ...ok, mergeBase: 'origin/main' }), null);
  assert.equal(reviewRequest({ ...ok, head: '--output=x' }), null);
  assert.equal(reviewRequest({ ...ok, files: [] }), null);
  assert.equal(reviewRequest({ ...ok, target: 'https://github.com/a/b/pull/3' }), null);
  assert.equal(reviewRequest({ ...ok, target: 'https://github.com/a/b/pull/3' }, u => u === 'https://github.com/a/b/pull/3').target, 'https://github.com/a/b/pull/3');
});
