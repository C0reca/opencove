# Reviewer agent (#57)

A pull request reaches the human review queue only after a reviewer agent has checked it, or after
the reviewer has asked for changes twice. The model is the two-stage review of Copilot code review
or CodeRabbit: an automated reviewer first, the human last, with a bounded loop.

## Flow

1. The engineer agent opens a PR that declares `Fixes #N` and finishes its turn.
2. The coordinator runs `reviewer.launch {projectId, number, pr}`.
3. The plugin creates the Space `review-<N>-<sha7>` with a worktree **detached** at the PR's head
   commit (`git fetch origin pull/<pr>/head`, `git checkout --detach <sha>`, then the temporary
   branch is deleted, so there is no branch to push). It writes the reviewer guard and launches a
   Claude Code agent in the repository's permission mode, not linked to the issue task.
4. The reviewer reads the issue and the diff, runs the project's tests and lint, and runs
   `reviewer.submit {projectId, number, pr, verdict: approve|changes, body}` once.
5. The plugin comments the verdict on the PR with a marker, then:
   - `approve`: `issue.request-review` (the issue gets `needs-review` and enters the queue);
   - `changes`, round 1: the work goes back to the engineer agent in its own worktree (the same
     path as the queue's "Request changes": written to a running agent, or the agent is relaunched);
   - `changes`, round 2: `issue.request-review` with a note that the rounds are spent.
6. After the engineer pushes, its next `done` wakes the coordinator, which runs `reviewer.launch`
   again for the new head commit.

## Invariants

1. **No PR reaches `needs-review` without a verdict or spent rounds.** `issue.request-review` (the
   only entry point agents have) is refused with `review-required` while any open PR declaring
   `Fixes #N` lacks an approval of its current head commit and has fewer than 2 `changes` verdicts.
   A push after an approval needs a new review.
2. **The reviewer never writes to the branch.** Its worktree is detached with no local branch. Its
   settings deny `Edit`, `Write`, `NotebookEdit`, `git commit` and `git push`, and its guard hook
   (role `reviewer`, the guard's 4th argument) refuses `git commit` and `git push` in any form it
   parses, including `git -C` and `sh -c`.
3. **Rounds are counted on GitHub.** Verdicts are PR comments that start with
   `<!-- opencove:reviewer verdict=<v> sha=<sha> -->`. Only comments by the gh account the plugin
   runs as count, so other GitHub users cannot forge one. Each commit gets at most one verdict.

## Who may submit

Only the reviewer: `reviewer.submit` is denied in the settings of engineer and coordinator agents, and
their guard refuses it. Every agent's guard refuses a gh command that contains the marker text.

**Limit.** All agents use the human's gh account, so the author check does not tell agents apart.
A marker written through `--body-file`, or a command the guard cannot parse, is not caught. The
guard and deny rules are the line here; review the PR's comments if a verdict looks out of place.

## Cleanup

Reviewer Spaces stay after the verdict. Removing them is part of the cleanup after merge (#58).
