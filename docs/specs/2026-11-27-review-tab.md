# Review tab

## Why

When Claude writes the code, the bottleneck moves to reading it. The dashboard says where a session stands, not what
it delivered: to judge the work, the developer goes through "Modified files" (uncommitted changes only), then the
commits one by one, or leaves for the forge once a merge request exists.

Goal: a tab of the right panel, **Review**, where the developer who drives the session reads what the session
produced, as one diff (the branch against its base), and where Claude helps reading it with a **guide**: what was
asked, what was done, its doubts, then the changes grouped by topic, the most important first. Inspired by the Guides
of Linear Reviews.

This is not a code review tool. It is for the author of the session to understand and judge the generated code
(quality, scope, relevance) before the usual review, which stays on the forge with the usual tools.

## What the tab shows

- **Targets**: what can be read.
  - The **branch of the session**, always there: its folder compared with its base, uncommitted changes included, so
    the work can be judged before any merge request exists.
  - The **merge requests / pull requests** of the session (GitHub and GitLab): the one of the branch (it then
    describes the branch target: title, state, CI, link), and the others, the ones the session created elsewhere or
    only cites (epic). With several targets, a list on top chooses the one displayed.
- **Header** of the target: title, state (open, draft, merged, closed), CI, `branch → base`, commits, files, lines,
  link to the forge.
- **Guide** (second delivery): "In short" (asked / done / extra / not done), the doubts, then the reading path: steps
  with an attention level (read closely, skim, incidental), why, what to check, and their files with the lines
  concerned. Steps are ticked "read". A banner says the diff changed since the guide.
- **Files** of the diff (list or tree, as "Modified files"). A click opens the diff of the target in the editor
  (Monaco). With a guide, the reading path takes the place of the folder tree in the editor, the step is recalled
  above the diff, its lines are marked, and the navigation follows the path. Files the guide did not place are listed
  under "Outside the path", computed by the page.

Read only: nothing is written to the forge (no comment, approval or merge). Questions go to the session through the
editor's existing 💬 bubble.

## Decisions

- **The session writes its own guide**: it knows the intent, and it costs one turn. It is a reading aid, not a
  critique (that stays `/code-review`).
- **On request**: a button, never at each push (it costs tokens). The guide keeps the fingerprint of the diff it
  describes and is marked outdated as soon as the diff changes.
- **Forges through their CLIs**, `gh` and `glab`, already logged in on the PC: no token to manage, no dependency.
  Without the CLI (or not logged in), the branch target still works; the tab says which CLI is missing.
- **A tab of its own** rather than more in "Modified files": a merge request is a range, sometimes of another branch.
- A merge request of **another repository** only has its state and its link (no diff, no guide).

## How

### Delivery 1: targets, state, range diff

- **Merge request URLs** (`public/core/mr-url.js`, pure, shared by page, server and engine): `parseMrUrl(url)` gives
  `{ forge, host, repo, number, url }` for `https://host/owner/repo/pull/N` (GitHub) and
  `https://host/group/…/project/-/merge_requests/N` (GitLab); `mrUrlsIn(text)` finds them in a text.
- **Session JSON**: `mrs`, an array of merge request URLs. Claude declares the ones it creates or works on through
  `update_board` (`boardFields` keeps only valid URLs; the tool adds to the list, `null` clears it). The driver also
  adds the URLs printed by a successful `gh pr create` / `glab mr create` (`driver/events.mjs`).
- **Forge** (`server/forge.mjs`): `mrOfBranch(dir, branch)` asks each remote of the repo for the request whose
  source is the branch (`gh pr list --repo … --head … --state all`, `glab mr list -R … --source-branch … --all`);
  `mrStatus(url)` reads one (`gh pr view <url>`, `glab mr view <n> -R …`). Both give the same shape
  `{ forge, number, title, state: 'open'|'merged'|'closed', draft, url, base, branch, head, ci: 'success'|'failed'|'running'|null }`
  (`normalizeGh`, `normalizeGlab`: pure, tested). Executables run without a shell, 15 s timeout, answers cached for a
  minute. A remote whose host is `github.com` goes to `gh`, any other to `glab`.
- **Range** (`server/git.mjs`):
  - `reviewBase(root, wanted)`: the base of the merge request when there is one, otherwise the default branch of
    `origin` (`refs/remotes/origin/HEAD`), otherwise develop, main, master (remote first).
  - `gitRange(dir, { base, head })`: merge base, commits, files with state and lines (`diff --name-status` and
    `--numstat` from the merge base to `head`, or to the working tree with the untracked files when `head` is
    empty), and a `fingerprint` of the whole.
  - `fileVersions(file, commit, range)`: `range = { base, head, from }` (commit ids only) gives the file at `base`
    (under its old name `from` after a rename) and at `head`, or on disk without `head`.
  - `fetchMr(root, mr)`: the head of a merge request of another branch is fetched into `refs/dash/mr/<n>`
    (`refs/pull/<n>/head`, `refs/merge-requests/<n>/head`), only when the target is opened, never by the polling.
- **Routes** (page server, `server/routes/review.mjs`, read only, `isPathAllowed` on the folder):
  `GET /api/review/targets?dir=&mrs=` (the branch, its merge request, the other ones with their state),
  `GET /api/review/range?dir=&target=` (`branch` or a merge request URL: the server chooses the refs, the page never
  sends a ref name), `GET /api/git/diff?file=&base=&head=&from=`.
- **Page**: `services/review.js`, `components/side/review.js` (`renderReview(d, bar)`), tab in
  `components/side/tabs.js` (count = merge requests), read again every 10 s while displayed (repainted only when the
  answer changed). `openViewer` gets `options.range`.

### Delivery 2: the guide

- **Tool** `set_review_guide({ target, guide })` of the `dashboard` MCP server (zod schema, relative paths, steps
  with `attention` high / medium / low): stored in the session JSON under `reviews[target]` (engine key) with the
  fingerprint and the date. An invalid guide is refused with the reason, Claude fixes it by itself.
- **Request**: `POST /api/sessions/:slug/review-guide { target, base, head, fingerprint, files }` dispatches a
  `[Dashboard]` message to the session (a ✨ line in the feed): target, base, the files of the diff, the format. The
  format lives in the tool description and in this message, not in the standing instructions.
- **Page**: guide blocks in the tab, `components/editor/review-nav.js` (reading path on the left of the editor, step
  banner, marked lines, navigation), read steps in `localStorage` (`dash-review-read-<slug>`, reset when the guide is
  redone), `outOfPath(files, guide)` (pure, tested).

## Non-goals

- Writing to the forge: comments, approvals, merge.
- Threads, approvals and CI detail of a merge request: one link opens the forge.
- Reviewing somebody else's merge request (a session opened on a URL): later, probably as a "review" tracker
  profile.
- A merge request pill in the session tree.
