// Merge request / pull request URLs, shared by the page, the page server and the engine. Pure.

const GITHUB = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/;
const GITLAB = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/|$)/;

/**
 * A merge request (GitLab) or pull request (GitHub) URL: `{ forge, host, repo, number, url }` (`url` without what
 * follows the number: tab, anchor, query), otherwise null. The forge is read from the path, so a self-hosted GitLab
 * is recognised whatever its host.
 */
export function parseMrUrl(value) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const gitlab = u.pathname.match(GITLAB), github = gitlab ? null : u.pathname.match(GITHUB);
  const m = gitlab || github;
  if (!m) return null;
  const forge = gitlab ? 'gitlab' : 'github', repo = m[1], number = Number(m[2]);
  return { forge, host: u.host, repo, number, url: `${u.protocol}//${u.host}/${repo}/${gitlab ? '-/merge_requests' : 'pull'}/${number}` };
}

/** The merge request URLs found in a text (output of `gh pr create`, `glab mr create`…), each one once. */
export function mrUrlsIn(text) {
  const found = new Set();
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    const mr = parseMrUrl(m[0]);
    if (mr) found.add(mr.url);
  }
  return [...found];
}

/** Valid merge request URLs of a list (normalised, each one once, `max` at most); anything else is dropped. */
export function cleanMrUrls(list, max = 20) {
  const urls = new Set();
  for (const v of Array.isArray(list) ? list : []) {
    const mr = typeof v === 'string' ? parseMrUrl(v) : null;
    if (mr) urls.add(mr.url);
  }
  return [...urls].slice(0, max);
}

/** Short name of a merge request: `!2691` (GitLab), `#12` (GitHub). */
export const mrLabel = mr => `${mr.forge === 'gitlab' ? '!' : '#'}${mr.number}`;
