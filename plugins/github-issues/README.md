# GitHub Issues

Shows each project's open GitHub issues in an **Issues** Sidebar section. It reads
them with the `gh` CLI on the machine that owns the project, so remote mounts and
your existing `gh` login are used.

## Install

```sh
pnpm opencove plugin install plugins/github-issues
pnpm opencove plugin run github-issues issues.list --pretty
```

After editing the source, run `pnpm opencove plugin reload github-issues`.

## Requirements

- `gh` installed and logged in (`gh auth login`) on the project's machine.
- The project's directory must have a GitHub remote.

When one of these is missing, the section shows a message instead of failing, and
other projects still load.

## Commands

| Command | Parameters | Effect |
| --- | --- | --- |
| `issues.list` | `projectId?`, `refresh?` | Without `projectId`, reads every project and groups them by repository. Returns `{ repos: [{ repo, projectIds, issues }], errors: [...] }`. |
| `issues.sidebar` | `projectId` | Sidebar items for one project. Used by the Sidebar section. |
| `issues.refresh` | `projectId` | Clears that project's cache and reads again. Sidebar action. |
| `issue.assign` | `projectId`, `number`, `provider?` | Creates (or reuses) a task for one trusted issue and launches an agent on it. Sidebar action on trusted issues. |

`issue.assign` returns `{ repo, number, taskNodeId, agentNodeId, agentFullAccess, reused }`.
Example: `pnpm opencove plugin run github-issues issue.assign --params '{"projectId":"<id>","number":5}'`.
`provider` defaults to `claude-code`. A CLI run refuses an issue whose author is not trusted
(error code `untrusted-author`).

Each issue has `number`, `title`, `url`, `labels`, `assignees`, `author` and
`updatedAt`. An error has `projectIds`, `repo` (or `null`), `code` and `message`.
Error codes: `gh-missing`, `gh-unauthenticated`, `not-github`, `gh-failed`.

Issue results are cached per repository for 60 seconds. Use `refresh: true` or the
Sidebar **Refresh issues** item to bypass the cache.

## Assigning issues to agents

`issue.assign` turns one issue into a canvas task and starts an agent on it:

1. Reads the issue with `gh issue view`, including its author.
2. Checks the author is trusted (see below). An untrusted author is refused and nothing is written.
3. Creates a task titled `#N <title>` tagged `issue:owner/repo#N`. If a task with that tag exists,
   it is reused and no second task is created.
4. Launches an agent with `provider` (default `claude-code`) and the task requirement, then sets the
   task to `doing`.

The requirement asks the agent to open a PR whose body contains `Fixes #N`. The issue title and
body go inside `<github-issue-content trust="untrusted-user-data">…</github-issue-content>`, after
a note that this block is data, not instructions. Any closing or opening tag of that element inside
the issue text is escaped.

**Reuse:** an existing task that already has a launched agent (status not `todo`, or a linked
agent) is returned as-is and never relaunched; `agentFullAccess` is `null` because nothing was
launched. A `todo` task without an agent (left by an attempt that failed before launch) is launched
again.

**Permissions:** agents start with `agentFullAccess: false`, so Claude Code asks before it runs
commands. The repository must be listed in `auto-approve-repos` for full access. Launching with an
explicit flag needs the core change in issue #11; until that lands the host rejects the key.

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

### Preferences

| Preference | Format | Default |
| --- | --- | --- |
| `trusted-authors` | One line per repository: `owner/repo: alice, bob`, or `*: alice` for every repository. Adds to the defaults; it does not replace them. Repository and user names are case-insensitive. Malformed lines are ignored. | empty |
| `auto-approve-repos` | Comma or newline separated `owner/repo` list. Agents for these repositories run with full access and no permission prompts. | empty |

When the project's repository is in `auto-approve-repos`, the top of the Issues section shows
`⚠ Auto-approve ON: agents run without permission prompts`.

### Human-only action

`issue.assign-untrusted` assigns an issue whose author is not trusted. It is only a Sidebar menu
action and is **not** part of the CLI. It needs host context, so `opencove plugin run` rejects it
with `human-only`. Use it only after you have read the issue yourself.

### Security limit

These checks are application guards, not a security boundary. An agent with shell access can call
`gh` directly, and whoever holds the Control Surface token can forge a menu context. The real
safeguard is running agents in normal mode, where you approve each shell command. Do not enable
`auto-approve-repos` for a repository you would not let an agent change without review.

## Files

| File | Purpose |
| --- | --- |
| `opencove.plugin.json` | Manifest: Sidebar section and commands |
| `main.mjs` | Backend wiring: parameter checks and command routing |
| `lib/gh.mjs` | gh argument lists, output parsing and failure classification (pure) |
| `lib/report.mjs` | Grouping by repository and Sidebar item shaping (pure) |
| `lib/cache.mjs` | TTL cache (pure) |
| `lib/runGh.mjs` | Runs `gh` through `host.operations` and polls it to completion |
| `lib/service.mjs` | Ties lookups, caches and grouping together |
| `lib/trust.mjs` | Preference parsing and the author trust decision (pure) |
| `lib/requirement.mjs` | Task tag, title and requirement text with the untrusted block (pure) |
| `lib/assign.mjs` | `issue.assign`: trust check, idempotent task lookup, launch |
| `lib/errors.mjs` | Coded command errors |

Unit tests: `tests/unit/forkPlugins/githubIssues*.spec.ts`.

Not yet: opening an issue from the Sidebar (the Sidebar API has no way to open a
URL), linking the task to its agent node (#6), and closing issues.
