# Cleanup after merge

Once an issue's pull request is merged, nothing else needs the issue's worktree, branches or Space.
The plugin removes them, so finished issues do not pile up on the canvas (#58).

## When it runs

A backend timer runs every 2 minutes, from activation until `dispose()`. Each pass reads the task
nodes of every project. A task is a candidate when it has an `issue:owner/repo#N` tag, a Space, and
status `doing`, `ai_done` or `done`. `done` is included because the task node only goes away with its
Space, the last step, so a `done` task that still exists means an earlier pass stopped part-way.

Only a Space named `issue-<N>` or `issue-<N>-<slug>`, which is the name `issue.assign` gives the
Space and its branch, is considered. `main`, `master`, `develop` and `trunk` are never touched.

## Steps

For each candidate, the pass first reads the merged pull requests from the branch
(`gh pr list --head <branch> --state merged`). It continues only for one that is `MERGED`, comes from
that branch, and declares it closes issue N (`Fixes #N`). Then, in order:

1. If the issue is still open, it comments with the PR link and closes the issue. GitHub usually
   closes it already on merge.
2. It marks the task `done`.
3. If the Space still has its worktree, it runs `opencove worktree archive --space <id>
   --delete-branch`, which removes the worktree and the local branch. It does not pass `--force`, so
   a worktree with uncommitted changes stops the cleanup and is kept.
4. If the remote branch still exists, it deletes it (`gh api -X DELETE .../git/refs/heads/<branch>`).
5. It runs `opencove space archive --space <id>`, which archives the Space and its nodes, the task
   included, to the archived Spaces list.

## Invariants

- Nothing is deleted without a merged pull request read in the same pass.
- Every step checks its own state first: issue already closed, task already done, no worktree
  left, remote branch already gone. Running it twice does no more and does not fail, and a pass
  that stopped is finished by the next one.
- A pass touches only the Space, worktree and branch of the task's own issue.

A failed step stops that issue for this pass. The reason is written to the plugin log.

## Preference

`auto-cleanup: false` turns it off. It is on by default.
