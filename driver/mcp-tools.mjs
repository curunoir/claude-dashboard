// Internal MCP server of a session: Tracker panel, other dashboard sessions, tracker profile.
import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as trackers from '../trackers.mjs';
import { createWorktree } from '../projects.mjs';
import { boardFields } from '../engine/board-fields.mjs';
import { cleanGuide, ATTENTIONS } from '../public/core/review-guide.js';
import { parseMrUrl } from '../public/core/mr-url.js';
import { migrateSession } from '../migration.mjs';
import { t } from '../public/i18n/index.js';
import { childMode } from './modes.mjs';

export const BOARD_TOOL = 'mcp__dashboard__update_board';
/**
 * Dashboard tools allowed without asking (allowedTools of the query): the panel and read-only ones. The others act on
 * other sessions or write files (launch, message, end, set_tracker): outside "all" mode they go through canUseTool (a
 * permission card, or the auto mode classifier) like any tool, so a session cannot get around its mode through another
 * session.
 */
export const DASHBOARD_TOOLS = [BOARD_TOOL, 'mcp__dashboard__list_sessions', 'mcp__dashboard__list_trackers', 'mcp__dashboard__set_review_guide'];

/** "dashboard" MCP server of the session: returns `{ dashboard }`, passed to the query (mcpServers). */
export function attachMcpTools(ctx) {
  const { s, slug, cwd, updateBoard, pushEvent, newId } = ctx;
  const { launch, list, write, end } = ctx.callbacks;

  const dashboard = createSdkMcpServer({
    name: 'dashboard',
    version: '1.0.0',
    tools: [tool('update_board',
      'Updates the Tracker panel of the dashboard (merges the given fields; null clears). See the session instructions for the fields (they depend on the tracker profile).',
      { state: z.record(z.string(), z.any()).describe('Board fields to merge') },
      async ({ state }) => {
        // The engine's own keys (folder, mode, conversation, counters…) are not the session's to change. A conversation
        // started before the English keys imitates its history and keeps sending French ones (choix, libelle…): converted
        const { fields, ignored } = boardFields(migrateSession(state));
        updateBoard(fields);
        if (Array.isArray(fields.decisions) && fields.decisions.length) pushEvent({ id: newId(), t: 'decisions', decisions: fields.decisions });
        return { content: [{ type: 'text', text: ignored.length ? `board updated; ignored (managed by the dashboard, or not a valid URL): ${ignored.join(', ')}` : 'board updated' }] };
      }, { alwaysLoad: true }), // loaded up front: no ToolSearch before the first call

    // Other dashboard sessions (like the Orca skills, but in the same worktree by default)
    tool('launch_session',
      'Launches a new Claude Code session in the dashboard, with a first message. By default in the same folder as this '
      + 'session. When the work concerns another project (another repository): pass `folder`, so that the session loads '
      + 'its CLAUDE.md, memories and settings. Only if the developer asks for another worktree or another branch: pass '
      + '`worktree` (creates a git worktree next to the repository, then a session in it). Do not wait for its answer: '
      + 'it lives its own life, the developer follows it in the dashboard.',
      {
        prompt: z.string().describe('First message of the new session: the subject, useful context, what is expected'),
        folder: z.string().optional().describe('Absolute path of the project where to launch the session (e.g. D:\\other-repo); default: the folder of this session'),
        worktree: z.object({
          branch: z.string().describe('Name of the branch to create (e.g. 2691-export-csv)'),
          base: z.string().optional().describe('Starting branch or commit; default: HEAD of the main worktree'),
        }).optional().describe('Only if another worktree is requested'),
        mode: z.enum(['all', 'auto', 'edits', 'ask', 'plan']).optional().describe('Tool permissions (all: no prompt, auto: classifier, edits: file edits accepted, ask: prompt, plan: read only, proposes a plan); never more permissive than this session; default: the mode of this session'),
      },
      async ({ prompt, folder: requested, worktree, mode: m }) => {
        let folder = cwd;
        if (requested) {
          folder = path.resolve(cwd, requested);
          if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory())
            return { content: [{ type: 'text', text: `Folder not found: ${folder}` }], isError: true };
        }
        if (worktree) {
          try { folder = await createWorktree(folder, worktree.branch, worktree.base); ctx.achievements.add('arborist'); }
          catch (e) { return { content: [{ type: 'text', text: `Worktree not created: ${e.message}` }], isError: true }; }
        }
        // Never more permissive than this session (a session in plan launches in "ask"): its tools would escape the
        // developer's approval
        const created = await launch({ cwd: folder, text: prompt, ...childMode(s.mode, m) });
        // Card of the launched session in this feed (rebuilt from the tool result after a restart: driver/history.mjs)
        pushEvent({ id: newId(), t: 'launched', slug: created, from: cwd, newWorktree: !!worktree });
        return { content: [{ type: 'text', text: `Session ${created} launched in ${folder}.` }] };
      }, { alwaysLoad: true }),
    tool('list_sessions',
      'Lists the dashboard sessions, to follow one or write to it: slug, displayed title, ticket, description, step, '
      + 'status, busy or not, folder, project, worktree branch and project group.',
      {},
      async () => ({ content: [{ type: 'text', text: JSON.stringify((await list()).filter(x => x.slug !== slug), null, 2) }] })),
    tool('message_session',
      'Sends a message to another dashboard session (delivered at the end of its turn if it is working).',
      { slug: z.string(), text: z.string() },
      async ({ slug: target, text }) => {
        const r = await write(target, text);
        return { content: [{ type: 'text', text: r || `Message sent to ${target}.` }], isError: !!r };
      }),
    tool('end_session',
      'Ends another dashboard session that is no longer needed (a worker session that has delivered, for example): '
      + 'its Claude process stops and it moves to "ended", still viewable; a message from the developer resumes it. '
      + 'A running turn is interrupted: only use it on a session that has finished its work.',
      { slug: z.string().describe('Slug of the session (see list_sessions)') },
      async ({ slug: target }) => {
        const r = await end(target);
        return { content: [{ type: 'text', text: r || `Session ${target} ended.` }], isError: !!r };
      }),

    // Tracker profile (skill /tracker): what the Tracker panel shows and what Claude puts in it
    tool('list_trackers',
      'Tracker profile of this session (and the file it comes from), the three possible files for this folder, the '
      + 'profiles built into the application and the block types.',
      {},
      async () => {
        const current = trackers.profileOf(cwd);
        return { content: [{ type: 'text', text: JSON.stringify({
          session: { id: current.profile.id, name: current.profile.name, source: current.source, file: current.file, preview: !!s.trackerPreview, profile: current.profile },
          files: trackers.filesOf(cwd),
          builtIn: trackers.builtInProfiles(),
          types: trackers.BLOCK_TYPES,
        }, null, 2) }] };
      }),
    tool('set_tracker',
      'Sets a tracker profile. Scopes: `preview` (this session only, nothing written; profile null removes it); '
      + '`install-repo` (for this repository, for this user only: ~/.claude-dashboard/trackers/repos/<repo>.json, '
      + 'takes precedence over everything); `repo` (in the repository, .claude/tracker.json, versioned, shared with the '
      + 'team); `default` (installation default: ~/.claude-dashboard/tracker.json). `profile`: a complete profile, the id '
      + 'of a built-in profile (the file points to it and follows its updates), or null to delete the file of this scope.',
      {
        profile: z.any().describe('{ id, name, description, steps: [{ key, label }], method, types?, blocks: [{ key, type, title?, instruction? } | { sideBySide: [..] }] }, or the id of a built-in profile, or null'),
        scope: z.enum(['preview', 'install-repo', 'repo', 'default']),
      },
      async ({ profile, scope }) => {
        try {
          // The profile sometimes arrives as JSON text ("null" included) rather than an object; a bare id stays an id
          if (typeof profile === 'string' && /^\s*[[{n]/.test(profile)) { try { profile = JSON.parse(profile); } catch { throw new Error('profile: unreadable JSON'); } }
          if (scope === 'preview') {
            if (typeof profile === 'string') profile = trackers.builtInProfiles().find(p => p.id === profile) || profile;
            if (profile) { const e = trackers.profileError(profile); if (e) throw new Error(e); }
            s.trackerPreview = profile || null;
            updateBoard({ trackerPreview: profile || null });
            return { content: [{ type: 'text', text: profile ? 'Preview shown in the Tracker panel of this session.' : 'Preview removed.' }] };
          }
          const file = trackers.writeTracker(cwd, scope, profile ?? null);
          s.trackerPreview = null;
          updateBoard({ trackerPreview: null });
          return { content: [{ type: 'text', text: profile == null ? `File deleted: ${file} (the next level applies).`
            : `Written: ${file}. The panel already shows it; the instructions of sessions will follow at their next start.` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Profile rejected: ${e.message}` }], isError: true };
        }
      }),

    // Reading guide of the Review tab: written by the session when the developer asks for it (s.requestReviewGuide)
    tool('set_review_guide',
      'Sets the reading guide of the Review tab for a target (the branch of the session, or one of its merge requests): '
      + 'what was asked, what was done, your doubts, then the changes grouped by topic in reading order. It helps the '
      + 'developer understand and judge what the session produced before the usual code review. Call it when the '
      + 'dashboard asks for it; the request gives the target, the diff and the rules.',
      {
        target: z.string().describe('The target exactly as given in the request ("branch", "branch:<folder>" or the URL of the merge request)'),
        guide: z.object({
          summary: z.string().describe('One or two sentences: what this diff does'),
          scope: z.object({
            asked: z.string().describe('What the developer asked for'),
            done: z.string().describe('What was done'),
            extra: z.array(z.string()).optional().describe('What was changed without being asked (renames, refactors, fixes on the way)'),
            notDone: z.array(z.string()).optional().describe('What was asked or could be expected and is not done'),
          }),
          doubts: z.array(z.string()).optional().describe('What you are not sure of, did not test, or assumed'),
          steps: z.array(z.object({
            title: z.string(),
            attention: z.enum(ATTENTIONS).describe('high: to read closely (logic, risk); medium: to skim; low: incidental (tests, renames, docs, generated)'),
            why: z.string().describe('What this group of changes does and why'),
            check: z.string().optional().describe('What the developer should verify here'),
            files: z.array(z.object({
              path: z.string().describe('Path relative to the repository, as in the diff'),
              lines: z.string().optional().describe('Lines concerned in the new version of the file, e.g. "40-95" or "12-30, 80-95"'),
              note: z.string().optional().describe('A few words: the function or the point to look at'),
            })),
          })).describe('Reading path: the order that makes the change understandable, the core first'),
        }),
      },
      async ({ target, guide: input }) => {
        // Another work folder (`branch:<folder>`) is only accepted as the target of the pending request
        const id = target === 'branch' || (target.startsWith('branch:') && s.reviewRequest?.target === target) ? target : parseMrUrl(target)?.url;
        if (!id) return { content: [{ type: 'text', text: 'Guide rejected: target must be the one given in the request' }], isError: true };
        const { guide, error } = cleanGuide(input);
        if (error) return { content: [{ type: 'text', text: `Guide rejected: ${error}` }], isError: true };
        // The fingerprint of the diff the developer was looking at when asking: the page marks the guide outdated once the diff differs
        const asked = s.reviewRequest?.target === id ? s.reviewRequest : null;
        updateBoard({ reviews: { [id]: { ...guide, fingerprint: asked?.fingerprint || '', createdAt: new Date().toISOString() } } });
        s.reviewRequest = null;
        return { content: [{ type: 'text', text: 'Guide shown in the Review tab. Tell the developer in one sentence that it is ready, without repeating it in the conversation.' }] };
      }),
    ],
  });
  /**
   * The developer asks for the reading guide of a target (button of the Review tab): the request goes to Claude with
   * the diff as the page shows it, a line marks it in the feed.
   */
  s.requestReviewGuide = r => {
    if (s.closed) return false;
    s.reviewRequest = { target: r.target, fingerprint: r.fingerprint };
    pushEvent({ id: newId(), t: 'auto', text: t('driver.feed.reviewGuideAsked') });
    const what = parseMrUrl(r.target) ? `the merge request ${r.target}` : `the branch ${r.headName || 'of this session'}`;
    const git = `git -C "${r.dir.replace(/\\/g, '/')}"`; // forward slashes: read the same by Git Bash and PowerShell
    const diff = r.head ? `${git} diff ${r.mergeBase} ${r.head}` : `${git} diff ${r.mergeBase} (working tree, uncommitted changes included, plus the untracked files listed below)`;
    ctx.dispatch([
      `[Dashboard] The developer asks for the reading guide of ${what} (Review tab of the dashboard). They drive this `
        + 'session and want to understand and judge what it produced (quality, scope, relevance) before the usual code review.',
      '',
      `Folder of the work: ${r.dir} (it may not be your current folder: the paths below are relative to it).`,
      `Diff to describe: ${r.baseName} → ${r.headName || 'HEAD'}. Read it with: ${diff}`,
      `Files of the diff (${r.files.length}):`,
      ...r.files.map(f => `- ${f.state} ${f.rel} +${f.insertions} -${f.deletions}`),
      '',
      `Read the diff, then call set_review_guide with target "${r.target}". Rules:`,
      '- Write it in the language you use with the developer, in plain sentences.',
      '- summary: one or two sentences.',
      '- scope: asked (what the developer asked, from this conversation; for changes that are not yours, from the commit '
        + 'messages or the merge request), done, extra (everything changed without being asked: renames, refactors, fixes '
        + 'on the way), notDone.',
      '- doubts: what you are not sure of, did not test, assumed, or would look at again. Be honest: it is the first '
        + 'thing the developer reads. Leave it empty only when there is truly none.',
      '- steps: 2 to 8, in the order that makes the change understandable (the core first, what depends on it after). '
        + 'Each file of the diff goes in one step; tests, renames, documentation and generated files are grouped in a last '
        + 'step with attention "low". attention "high" only where a mistake would matter (logic, security, data).',
      '- why says what the group does and why; check says what the developer should verify; lines are those of the new '
        + 'version of the file.',
      'Then tell the developer in one sentence that the guide is ready; do not repeat it in the conversation, and resume '
        + 'where you were.',
    ].join('\n'));
    return true;
  };
  /** Mermaid diagram of the panel that the page could not draw: Claude fixes it without waiting for the developer. */
  s.reportSchema = (key, error) => {
    if (s.closed) return false;
    pushEvent({ id: newId(), t: 'auto', text: t('driver.feed.schemaNotRendered', { key }) });
    ctx.dispatch(`[Dashboard] The Mermaid diagram of the field "${key}" (update_board) does not render in the panel: `
      + `${String(error).slice(0, 600)}
Fix the syntax and send the whole field "${key}" again with update_board, `
      + `then resume where you were (no need to mention it to the developer).`);
    return true;
  };
  return { dashboard };
}
