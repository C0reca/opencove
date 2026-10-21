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

Each issue has `number`, `title`, `url`, `labels`, `assignees`, `author` and
`updatedAt`. An error has `projectIds`, `repo` (or `null`), `code` and `message`.
Error codes: `gh-missing`, `gh-unauthenticated`, `not-github`, `gh-failed`.

Issue results are cached per repository for 60 seconds. Use `refresh: true` or the
Sidebar **Refresh issues** item to bypass the cache.

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

Unit tests: `tests/unit/forkPlugins/githubIssues*.spec.ts`.

Not yet: opening an issue from the Sidebar (the Sidebar API has no way to open a
URL), assigning issues to agents and closing issues.
