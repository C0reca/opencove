# Review queue

The review queue is the human's single list of pull requests ready for a decision. It is a
plugin window (`view.instances: single`): one shared window for every project on the Worker.
Open it from the canvas action bar or context menu, or with
`opencove plugin open github-issues --project <id>`. A `commandCenter` menu command cannot
open it: the host never creates a window from a menu dispatch.

**What it lists.** For each repository of the open projects: open pull requests (up to 50) that
declare `Fixes #N` for an issue with the `needs-review` label. Each entry shows the source issue,
the agent's summary and evidence (from its newest `issue.request-review` comment), the changed
files with a link to the diff, the CI state from `statusCheckRollup` (passing, failing, pending or
none) and the PR's age. The list is cached for 30 seconds per repository; **Refresh** reads again.

**Actions.** They exist only as `api.invoke` methods of the view (`review.merge`,
`review.request-changes`, `review.close`). They are not declared commands, so `opencove plugin run`
cannot reach them and no agent can merge or close a pull request.

- **Merge (squash):** reads the PR again, merges it with `gh pr merge --squash` only while it is
  `OPEN` and declares `Fixes #N`, then closes the issue through `issue.close`. A PR that is already
  `MERGED` is not merged again; only the issue close runs. A second merge of the same PR while one is
  running is refused, and the view disables its buttons while a decision runs.
- **Request changes:** needs a comment. Comments on the PR, removes `needs-review` and hands the work
  back to the issue's engineer agent. A running agent gets the comment in its terminal (text, then
  Enter). A stopped one is closed and relaunched in the issue's existing Space, linked to the same
  task, with the comment added to its prompt. No second worktree is ever created.
- **Close without merge:** needs a comment. Closes the PR with it and removes `needs-review`. The
  issue stays open.

PR titles, summaries and evidence are untrusted text; the view renders them with `textContent` only.
In the Settings preview the queue is empty and the actions are refused.
