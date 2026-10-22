# GitHub Issues

Shows each project's open GitHub issues in an **Issues** Sidebar section. It reads
them with the `gh` CLI on the machine that owns the project, so remote mounts and
your existing `gh` login are used. It can also start Claude Code agents on issues and
run a coordinator that follows them (see [Autonomous agents](#autonomous-agents)).

## Install

```sh
pnpm opencove plugin install plugins/github-issues
pnpm opencove plugin run github-issues issues.list --pretty
```

After editing the source, run `pnpm opencove plugin reload github-issues`.

## Requirements

- `gh` installed and logged in (`gh auth login`) on the project's machine.
- The project's directory must have a GitHub remote.
- The `opencove` CLI on PATH on the project's machine (Settings → Worker → CLI → Install CLI),
  for worktrees and the coordinator.
- A root Space with a canvas position in the project. Issue Spaces are created under it.
- A POSIX target (macOS or Linux): commands are launched through `/usr/bin/env`.

When one of these is missing, the section shows a message instead of failing, and
other projects still load.

### How gh is run

Host operations run inside a PTY, so a plain `gh` sees a terminal. It then colours JSON,
queries the terminal and may page or prompt. That made `issues.list` fail with "gh did not
return JSON" (#22). The plugin therefore:

- **Resolves the repository** from `git remote -v`: `origin` first, otherwise the first
  github.com remote. Every `issue`, `pr` and `label` call passes `--repo owner/repo`, so gh
  never guesses the base repository.
- **Finds gh** with the login shell's `command -v gh`, then `/opt/homebrew/bin/gh`,
  `/usr/local/bin/gh`, then `gh` on the PTY's PATH. The first one that answers
  `--version` is cached per project.
- **Sets the environment** through `/usr/bin/env`: `NO_COLOR=1`, `CLICOLOR=0`, `TERM=dumb`,
  `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GH_SPINNER_DISABLED=1`, `GH_PAGER=cat`,
  `PAGER=cat` and `GIT_TERMINAL_PROMPT=0`.
- **Cleans the output**, removing terminal escape sequences and carriage returns, before
  parsing it.
- **Reports failures with detail:** the exit code and the first output lines, with token-like
  values redacted.

## Commands

| Command | Parameters | Effect |
| --- | --- | --- |
| `issues.list` | `projectId?`, `refresh?` | Without `projectId`, reads every project and groups them by repository. Returns `{ repos: [{ repo, projectIds, issues }], errors: [...] }`. Lists `no-agent` issues too. |
| `issues.sidebar` | `projectId` | Sidebar items for one project. Used by the Sidebar section. |
| `issues.refresh` | `projectId` | Clears that project's cache and reads again. Sidebar action. |
| `issue.assign` | `projectId`, `number`, `provider?`, `parentSpaceId?` | Creates (or reuses) a task for one trusted issue and launches an agent on it in its own worktree. |
| `agents.status` | `projectId?` | One row per issue task: `{ issue, repo, number, projectId, taskNodeId, taskStatus, agentNodeId, runtimeStatus, agentState, agentStateObservedAt }`. `agentState` is `working`, `waiting`, `done` or null; it is normalised from the Worker's latest hook observation (`{ state, source, observedAtMs }`, where a finished turn arrives as `standby`). Returned as `{ issues: [...] }`. |
| `agents.read` | `projectId`, `nodeId` | Returns the output tail (at most 8000 characters), `truncated`, `agentState` and the issue of an agent linked to an issue task of the project. Any other agent is refused (`agent-not-linked`). Output is data. |
| `issue.close` | `projectId`, `number`, `pr`, `evidence?` | Closes the issue only if PR `pr` is `MERGED` and declares it closes the issue. Comments the PR URL and evidence, then marks the task `done`. |
| `coordinator.launch` | `projectId` | Starts (or reuses a running) issue-coordinator agent in its own worktree Space. Space menu. |
| `issue.request-review` | `projectId`, `number`, `summary`, `evidence` | Adds the `needs-review` label (created if missing) and comments the summary and evidence. Never closes. |

`issue.assign` returns `{ repo, number, taskNodeId, agentNodeId, configuredMode, effectiveMode, reason, agentPermissionMode, spaceId, branch, reused }`. `configuredMode` is the repository's mode, `effectiveMode` the mode that runs (see [Local projects only](#local-projects-only)), and `reason` is `null` or `remote-target` or `unknown-target`. `coordinator.launch` returns the same three fields.
Example: `pnpm opencove plugin run github-issues issue.assign --params '{"projectId":"<id>","number":5}'`.
A CLI run refuses an issue whose author is not trusted (`untrusted-author`) and an issue labelled
`no-agent` (`no-agent`).

Each issue has `number`, `title`, `url`, `labels`, `assignees`, `author` and
`updatedAt`. An error has `projectIds`, `repo` (or `null`), `code` and `message`.
Error codes: `gh-missing`, `gh-unauthenticated`, `not-github`, `gh-failed`.

Issue results are cached per repository for 60 seconds. Use `refresh: true` or the
Sidebar **Refresh issues** item to bypass the cache.

## Autonomous agents

Every agent the plugin launches (issue agents and the coordinator) follows the same rules:

1. **Its own worktree.** It runs in a child Space with its own git worktree, never in the
   project's directory or on the canvas.
2. **A permission mode per repository** (see [Permission modes](#permission-modes)).
3. **The mandatory guard** (see [Agent guard](#agent-guard)), written into its worktree
   before it starts.

### Permission modes

Preference `permission-modes`: one line per repository.

```text
C0Reca/opencove: auto
other/repo: normal
C0reca/*: full
```

- Modes are `normal`, `auto` or `full`. The default for every repository is `normal`.
- `owner/*` covers every repository of an owner. The **exact line wins** over the wildcard, whatever
  their order.
- A line with an unknown mode is `normal` (fails closed). Malformed lines are ignored.
- The mode is passed to the core as `agentPermissionMode` on every launch, issue agents and the
  coordinator alike, and it is also used when an agent is resumed:

| Plugin mode | Core `agentPermissionMode` | Meaning |
| --- | --- | --- |
| `normal` | `default` | Claude Code asks before each action it is not allowed to take. |
| `auto` | `auto` | Claude Code's auto mode decides. |
| `full` | `full` | No permission prompts. |

The guard applies in every mode, including `full`.

### Local projects only

`auto` and `full` apply only when the launch target is local. On a remote project (a Space or project
whose mount is another machine, or whose location cannot be determined) the effective mode is
`normal`, for the coordinator and for every issue agent. Nothing is refused: the launch proceeds in
`normal`, and the result's `reason` says why (`remote-target` or `unknown-target`).

Why: the PreToolUse guard hook runs the Worker's `process.execPath` and the installed plugin path.
Those paths do not exist on a remote target. Claude Code treats a non-blocking hook error as allow,
so the guard would fail open there and only the `permissions.deny` prefix rules would remain. Normal
mode keeps the prompts, so the missing guard is not a silent loss of control.

Locality is decided once per launch from `host.target.resolve` for the project and Space being
launched. A local mount reports `endpointId: "local"`; remote endpoints have opaque registry ids.
Any other answer, or a failed lookup, is treated as remote (fail closed). `normal` is never resolved.

The guard file is still written in `normal` on remote targets, as defence in depth. If that write
fails on a remote target, the launch fails as it always did, because the guard is written before the
agent starts.

The Sidebar shows the fallback in its top item, in place of the local warning:
`⚠ auto configured, running in normal: remote project (guard cannot run there)`. Local `auto` and
`full` keep `⚠ Agents run in auto mode` and `⚠ Agents run in full access`.

**Migration from `auto-approve-repos`.** That preference is replaced by `permission-modes`. Until you
migrate, a repository listed in `auto-approve-repos` counts as `full`, unless `permission-modes` has
a line for it (an exact line or an owner wildcard). That keeps the old behaviour and lets you move to
`auto` or `normal` explicitly. The `worktree-repos` preference is gone because every issue agent now
has a worktree.

The Sidebar's top item shows the mode when it is not `normal`: `⚠ Agents run in auto mode` or
`⚠ Agents run in full access`.

### Agent guard

Every plugin agent gets `.claude/settings.local.json` in its worktree. The file is written before
the agent starts, and `.claude/settings.local.json` is added to the repository's common
`info/exclude`, so it is never committed. It has three layers.

**(a) `permissions.deny`** (plain prefixes, checked by Claude Code):

- `Bash(gh pr merge:*)`, `Bash(gh pr close:*)`, `Bash(gh issue close:*)`, `Bash(gh api:*)`
- `Bash(git push --force:*)`, `Bash(git push -f:*)`, `Bash(git push --force-with-lease:*)`
- `Edit(/.claude/**)`. The leading slash anchors the rule to the worktree root. Claude Code never
  consults `Write` path rules, so `Edit` covers every write.

**(b) `permissions.allow`** (read-only and plugin commands, no prompt):

- `gh pr list`, `gh pr view`, `gh issue list`, `gh issue view`, each with `-R` or `--repo`.
- `opencove plugin run github-issues` with `agents.status`, `agents.read`, `issues.list`,
  `issue.assign`, `issue.request-review` and `issue.close`.
- `opencove plugin skill github-issues:*` and `opencove project list:*`.

`issue.close` stays allowed because the plugin refuses it unless the PR is `MERGED` and declares
`Fixes #N`. It is the only way for an agent to finish an issue. `issue.assign-untrusted` and
`issue.close-manual` are human-only; the CLI refuses them, so the prefix rules cannot reach them.

**(c) A `PreToolUse` hook for Bash**, which runs in exec form:

```text
command: /usr/bin/env
args:    ELECTRON_RUN_AS_NODE=1, <the Worker's process.execPath>, <plugin>/guard/agentGuard.mjs, <worktree root>
```

`process.execPath` is OpenCove's own runtime (Electron, which needs `ELECTRON_RUN_AS_NODE=1` to run
as Node), the same rule the OpenCove hook relay uses. The guard resolves its own path from
`import.meta.url`. The worktree root is its one argument. It reads the hook's JSON from stdin and
answers with `hookSpecificOutput.permissionDecision: "deny"` and a reason, or prints nothing and
exits 0, which leaves the decision to the normal permission flow. It never approves a call.

The guard denies:

- `gh pr merge`, `gh pr close`, `gh issue close` and `gh api`, also after `-R`/`--repo`, after
  `env VAR=…`, and inside `sh -c`, `$(…)` and backticks;
- `git push` with `--force`, `-f` (also in a cluster such as `-fu`), `--force-with-lease`,
  `--force-if-includes` or `--mirror`, and any `+refspec`;
- `git push` whose destination is `main` or `master` (`origin main`, `HEAD:main`,
  `HEAD:refs/heads/main`, `:main`, `:refs/heads/main`), and any wildcard destination;
- `git reset --hard` run in, or aimed with `-C` at, a directory outside the worktree root, and
  `GIT_DIR` or `GIT_WORK_TREE` set on a git command;
- `rm` with `-r`, `-R`, `-rf`, `-fr` or `--recursive` whose target resolves outside the worktree
  root, or is the root itself;
- any write to `.claude/`: redirections (`>`, `>>`, `>|`, `&>`), `tee`, `cp`, `mv`, `rm`, `touch`,
  `ln`, `install`, `truncate`, `chmod` and `sed -i`. `dd of=` is not covered (a listed limit).

`cd` inside a command moves the directory the rules are checked against. `rm -r` and writes to
`.claude/` with a target the guard cannot resolve (`~`, `$VAR`, a backtick) are denied, because
they cannot be verified.

**Limits of the guard.** It parses a shell subset, not a shell. It splits on `&&`, `||`, `;`, `|`,
`&` and newlines, and handles quotes, `\x`, `env`, `command`, `exec`, `nohup`, `time`, `cd`,
`git -C` and nested `sh -c`. It does not handle `eval`, heredocs, brace or glob expansion, or
arbitrary variables. It does not inspect programs outside its list. Prefix rules match the text as
written, so the `permissions.deny` layer misses forms such as `git push origin -f`; the hook covers
them. The guard runs on the Worker's machine with the Worker's runtime, so it fits local worktrees,
the same as OpenCove's own hook relay. If the guard cannot run, Claude Code treats a non-blocking
hook error as allow, so the protection depends on the guard being installed where the agent runs.
Malformed hook input is allowed with a note on stderr.

### Why the merge is human-only

A merge is the one step that changes the main branch for good. The coordinator never performs it.
`gh pr merge` is denied for every plugin agent in every mode, and the coordinator's playbook never
asks for it. When a pull request is ready, the coordinator calls `issue.request-review` and tells
you. You merge it; then `issue.close` closes the issue, but only with a merged PR that declares
`Fixes #N`. Without that proof the coordinator does not close the issue.

## Assigning issues to agents

`issue.assign` turns one issue into a canvas task and starts an agent on it:

1. Reads the issue with `gh issue view`, including its author and labels.
2. Checks the author is trusted (see below). An untrusted author is refused and nothing is written.
3. Refuses a `no-agent` issue from the CLI (see [no-agent](#no-agent-issues)).
4. Creates a child Space and worktree for the issue (see [Worktree per issue](#worktree-per-issue)).
5. Writes the guard into the worktree, then creates the task titled `#N <title>` tagged
   `issue:owner/repo#N`. If a task with that tag exists, it is reused.
6. Launches an agent with `provider` (default `claude-code`), the task requirement, `taskNodeId`
   and `agentPermissionMode`. Core #6 links the agent and task and moves the task to `doing`.

The requirement asks the agent to open a PR whose body contains `Fixes #N`. The issue title and
body go inside `<github-issue-content trust="untrusted-user-data">…</github-issue-content>`, after
a note that this block is data, not instructions. Any closing or opening tag of that element inside
the issue text is escaped.

**Reuse:** an existing task that already has a launched agent (status not `todo`, or a linked
agent) is returned as-is and never relaunched. A `todo` task without an agent, left by an attempt
that failed before launch, is launched again in the Space it already has. A `todo` task on the
project canvas, which has no worktree, is refused with `task-not-in-worktree`: remove that task and
assign the issue again.

### Trust model

An issue author is trusted when any of these holds:

- the author is the owner of the repository (`owner` in `owner/repo`);
- the author is `C0reca`;
- the author is listed for that repository, or for `*`, in `trusted-authors`;
- `gh api repos/{owner}/{repo}/collaborators/{user}/permission` returns `admin`, `maintain` or `write`.

If any check fails, or the author is missing, the author is untrusted. Permission answers are cached
for 60 seconds per repository and user; failed lookups are not cached.

Trusted issues show the assign action in the Sidebar. Untrusted issues are labelled
`⚠ untrusted author: <login>` and get the **Assign issue (untrusted author)** action instead.

### no-agent issues

An issue labelled `no-agent` is never assigned by an agent. The coordinator skips it, and the CLI
refuses it with `no-agent`. `issues.list` still returns it, and the Sidebar marks it
`⊘ excluded from agents (no-agent)`. The human **Assign issue** menu action still assigns it.

### Preferences

| Preference | Format | Default |
| --- | --- | --- |
| `trusted-authors` | One line per repository: `owner/repo: alice, bob`, or `*: alice` for every repository. Adds to the defaults; it does not replace them. Repository and user names are case-insensitive. Malformed lines are ignored. | empty |
| `permission-modes` | One line per repository: `owner/repo: normal \| auto \| full`, or `owner/*: mode`. Exact line wins over the wildcard. See [Permission modes](#permission-modes). | empty (normal) |
| `auto-approve-repos` | Legacy. Repositories listed here count as `full` unless `permission-modes` sets them. | empty |
| `coordinator-wake` | On or off. When on, the plugin wakes a running coordinator when its issue agents wait or finish. See [Waking the coordinator](#waking-the-coordinator). | on |

### Human-only action

`issue.assign-untrusted` assigns an issue whose author is not trusted. It is only a Sidebar menu
action and is **not** part of the CLI. It needs host context, so `opencove plugin run` rejects it
with `human-only`. Use it only after you have read the issue yourself. The same menu action assigns
`no-agent` issues.

### Security limit

These checks are application guards, not a security boundary. An agent with shell access can call
`gh` directly, and whoever holds the Control Surface token can forge a menu context. The guard in
[Agent guard](#agent-guard) narrows what an agent can do, and it has the limits listed there.

## Coordinator commands

These commands let a coordinating agent follow the issue tasks it created. They run with
`opencove plugin run github-issues <command> --params '…'`.

**`agents.status`** reads every task whose tag is `issue:owner/repo#N` and finds its agent:

- `agentState` comes from `host.agents.get`: `working`, `waiting`, `done`, or `null` when unknown.
  It is an observation, not proof that the work is finished. Never close an issue on it.
- `runtimeStatus` is the agent node's status in the canvas.
- The agent comes from the task's stored link, `linkedAgentNodeId`, which core #6 sets when the
  agent is launched with `taskNodeId`.
- Legacy fallback: a task created before #6 has no stored link. For those only, an agent matches
  when its prompt is the issue requirement or its title is the task title; the last match wins.
  Remove this fallback once no unlinked issue task remains.

**`issue.close`** closes only on evidence. It refuses, with no writes, when:

- the PR cannot be read: `pr-not-found`;
- the PR is not `MERGED`: `pr-not-merged`;
- the merged PR does not declare that it closes this issue (no `Fixes #N`): `pr-not-linked`.
  Refusing here keeps the evidence about the right change.

There is no `force` parameter. Without a merged PR, use `issue.request-review`.

**`issue.request-review`** is the path when no PR is merged. The label creation uses `--force`, so
repeated calls are safe. The issue stays open for a person to decide.

Every gh call uses an argument list, not a shell string. Evidence and summary text is written as
one argument and is never combined with issue content from GitHub.

### Human-only actions

`issue.close-manual` closes an issue **without** a pull request. It needs host context, so the
CLI rejects it with `human-only`. It is declared as a Sidebar menu action, but no Sidebar item
invokes it yet. Use it only from a menu, after reading the issue yourself. It records the reason in the closing comment.

Like `issue.assign-untrusted`, it is not in the CLI usage text.

## Worktree per issue

Every issue agent gets its own worktree. `issue.assign` does this:

1. Creates a child Space of the project's root Space, named `issue-<N>-<slug>`, with
   `opencove space create --parent <root> --name <name> --project <id>`. The slug is the title reduced
   to lowercase ASCII letters, digits and single hyphens, at most 40 characters. The title is untrusted,
   so nothing else reaches the command. A title with no ASCII letters gives `issue-<N>`.
2. Creates a worktree on the branch of the same name with `opencove worktree create --space <child> --name <name>`.
3. Writes the guard into that worktree, creates the task inside the child Space, and launches the
   agent there, so its working directory is the worktree.

- **Root Space:** the plugin lists the project's Spaces with `opencove space list --project <id>`. The
  root is the one Space with no parent whose directory is not a `.opencove/worktrees` directory. If
  there is no such Space, or more than one, the call fails and nothing is created. Pass
  `"parentSpaceId":"<id>"` to choose one explicitly. It must be a Space of this project.
- `worktree` is no longer a choice. Omit it or pass `true`; `false` is refused (`invalid-params`).

Failures are structured and nothing is deleted:

| Code | Meaning |
| --- | --- |
| `cli-missing` | The `opencove` CLI is not on PATH on the project machine. |
| `parent_missing_rect` | The root Space has no canvas position. Place it on the canvas, then retry. |
| `branch-exists` | A branch or worktree with that name already exists. |
| `no-root-space` | The project has no root Space to hold worktrees. |
| `ambiguous-root-space` | More than one root Space. The error lists the candidates (id and name). Pass `parentSpaceId`. |
| `parent-not-in-project` | The `parentSpaceId` given is not a Space of this project. |
| `task-not-in-worktree` | A todo task for the issue exists on the project canvas. Remove it, then assign again. |
| `guard-failed` | The guard file or its `info/exclude` entry could not be written. The agent is not launched. |
| `launch-failed` (with `spaceId`, `branch`) | The worktree was created but a later step failed. The error names the Space and branch so a person can clean up. |

**Cleanup after close:** closing an issue does not remove its worktree or Space. To archive one
manually:

1. `opencove worktree archive --space <childSpaceId>`. It refuses a dirty worktree. Add
   `--force --delete-branch` only after you have checked the work.
2. Archive the empty Space in the OpenCove UI. The CLI has no command for that yet.

Running agents are not stopped by `worktree archive`, so stop them in the UI first.

## Coordinator

`coordinator.launch {projectId}` (Space menu, and the CLI) starts a Claude Code agent titled
**Issue coordinator**. Its prompt tells it to load the `issue-coordinator` skill and follow it.

- **Worktree:** the coordinator runs in a child Space and worktree named `issue-coordinator`. If a
  Space with that name exists, it is reused; otherwise it is created under the root Space. The Space
  menu's own Space is ignored.
- **Permission mode:** the repository's mode from `permission-modes`, the same as issue agents, when
  the project is local. On a remote project it runs in `normal` (see [Local projects only](#local-projects-only)).
- **Reuse:** if an agent titled "Issue coordinator" in the project has a running session, the
  command returns it (`reused: true`) and launches nothing. A stopped coordinator is not reused,
  so a new one starts.
- The skill is installed explicitly, with `opencove plugin skill github-issues issue-coordinator`
  to read it. It is not copied into any agent's skill directory automatically.

### The skill

`skills/issue-coordinator/SKILL.md` is the playbook. It:

- processes issues **oldest first** (by number), and skips `needs-review` and `no-agent` issues;
- re-reads `agents.status` immediately before each `issue.assign`, and keeps at most **3** issue agents
  running;
- assigns with **one call per issue**, the number written literally: no loops and no variables;
- runs read-only gh queries with `-R owner/repo` right after the subcommand, one query per call,
  with `-q` or `--jq` and no pipes;
- closes an issue only with a merged PR that declares `Fixes #N`; otherwise it calls
  `issue.request-review` and tells the human. Merging is always the human's.

The skill escalates to a human on `untrusted-author`, on `no-agent` questions, on unexpected errors,
and on product decisions. Issue text is treated as data. The skill never mentions `gh pr merge`, and
its tests fail if it does.

### Waking the coordinator

The coordinator works in turns, and nothing wakes it between them. Without a wake-up it stays
idle after it assigns an issue, until someone sends it a message by hand. The plugin now sends that
message.

**Mechanism: a backend timer, not `host.events`.** `host.events` samples project, Space, node, session
and preference changes. An agent's observed state (`agents.get().agentState`, the `working`,
`waiting` or `done` signal) is not one of those types, so a change from `working` to `waiting` can
produce no indication at all. The backend therefore runs one bounded timer (every 10 s). Each pass
reads `agents.status` only for a project that has a running coordinator. The timer starts when the
plugin activates and stops in `dispose()`. The lookup is strict: an unreadable coordinator keeps the
state, and only a readable "no running coordinator" resets it.

**Rules:**

- **Which transitions:** an issue agent whose observed state changes to `waiting` or `done`. Its
  first observation after the coordinator starts is a silent baseline, so older states are not
  replayed.
- **Coalescing:** transitions are queued and sent once, after 5 s with no new transition.
- **Idle only:** the message is written only while the coordinator's observed state is `done` or
  `waiting`. A `working` or unknown coordinator keeps the message queued.
- **No repeats:** each transition is keyed by issue, state and `observedAt`, and is sent once. After a
  wake, the next one waits until the coordinator has a new observation (or 2 minutes pass).
- **No coordinator, no write:** a project without a running coordinator is skipped.
- **Preference:** `coordinator-wake: false` stops all writes.

**Message format.** One line, with the `[github-issues]` prefix, which is the only prefix the skill
treats as a wake trigger:

- `[github-issues] #43 agent is now waiting. Read it with agents.read and tell the human what it asks.`
- `[github-issues] #43 agent is done. Run your next loop.`
- Several transitions: `[github-issues] #43 agent is now waiting; #44 agent is done. Read it with agents.read and tell the human what it asks. Run your next loop.`

**Paste protection workaround.** A long prompt plus `\r` in one write is treated by Claude Code as a
paste: it shows "Removed 1 invisible character · review and press Enter" and does not submit. So the
text and the Enter key are sent as two writes: the text first, then `\r` after 1.5 s. The first
write has no carriage return.

**Limits:**

- The message is typed into the coordinator's terminal. If a person is typing there, the text is
  appended to what they typed. The plugin cannot see that.
- If the text write fails, the message stays queued. If the Enter write fails, the text may sit
  unsent in the coordinator's input; the plugin does not resend it, so it is not doubled. A person
  must submit it.
- The reaction check assumes the coordinator's observation changes when it starts a turn. If it does
  not, the next wake waits for the 2-minute hold.
- The timer runs while the plugin backend runs. A plugin reload resets the baseline, so transitions
  during the reload are not replayed.
- Polling `agents.status` every 10 s costs a few host calls per project with a coordinator.

## Files

| File | Purpose |
| --- | --- |
| `opencove.plugin.json` | Manifest: Sidebar section, commands, preferences |
| `main.mjs` | Backend wiring: parameter checks and command routing |
| `lib/gh.mjs` | gh argument lists, output parsing and failure classification (pure) |
| `lib/report.mjs` | Grouping by repository and Sidebar item shaping (pure) |
| `lib/cache.mjs` | TTL cache (pure) |
| `lib/runGh.mjs` | Resolves gh and opencove, runs them through `/usr/bin/env` with `host.operations`, and polls them |
| `lib/service.mjs` | Ties lookups, caches and grouping together |
| `lib/trust.mjs` | Preference parsing and the author trust decision (pure) |
| `lib/permissions.mjs` | `permission-modes` parsing, precedence and migration; core mode mapping (pure) |
| `lib/locality.mjs` | Local-only autonomy: the target's locality and the effective mode per launch |
| `lib/agentSettings.mjs` | The guard written into each worktree: settings, deny and allow lists, `info/exclude` |
| `guard/agentGuard.mjs` | The PreToolUse guard. `decide(input, worktreeRoot)` is pure |
| `guard/tokenize.mjs` | The guard's shell-subset tokenizer (pure) |
| `lib/requirement.mjs` | Task tag, title and requirement text with the untrusted block (pure) |
| `lib/assign.mjs` | `issue.assign`: trust and `no-agent` checks, idempotent task lookup, worktree, launch |
| `lib/errors.mjs` | Coded command errors |
| `lib/params.mjs` | Shared parameter validation (pure) |
| `lib/tasks.mjs` | Task lookups by issue tag and status writes |
| `lib/status.mjs` | `agents.status` shaping and the agent-to-task fallback |
| `lib/closing.mjs` | `issue.close`, `issue.request-review`, `issue.close-manual` |
| `lib/coordinator.mjs` | `coordinator.launch`: prompt, the coordinator Space, reuse rule |
| `lib/agentRead.mjs` | `agents.read`: link restriction and output bound |
| `lib/wake.mjs` | Coordinator wake-up: transition detection, coalescing, idle gating, two-write submission |
| `lib/worktree.mjs` | Worktree per issue: name sanitising, Space listing, CLI calls, error classes |
| `skills/issue-coordinator/SKILL.md` | Coordinator playbook (Agent Skills format) |

Unit tests: `tests/unit/forkPlugins/githubIssues*.spec.ts`. The guard's decision table is in
`githubIssuesGuard.spec.ts`.

Not yet: opening an issue from the Sidebar (the Sidebar API has no way to open a
URL), linking the task to its agent node (#6), and a Sidebar item for `issue.close-manual`.
