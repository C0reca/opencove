# Connecting a new project

1. **Open the repository in OpenCove** as a project. It must be a local clone with a GitHub remote
   (`gh` resolves `owner/repo` from it) and `gh` must be signed in.
2. **Root Space:** keep exactly one root Space and place it on the canvas. Issue and coordinator
   Spaces are created under it (`no-root-space`, `ambiguous-root-space`, `parent_missing_rect`
   otherwise; see [Worktree per issue](README.md#worktree-per-issue)).
3. **`permission-modes`:** add a line `owner/repo: normal | auto | full`. Without one the agents run
   in `normal` and ask for every command. See [Permission modes](README.md#permission-modes).
4. **`max-agents`:** add `owner/repo: N` if 2 agents at a time is not right for this repository.
5. **`trusted-authors`** (optional): extra people whose issues agents may take. Collaborators with
   write access are trusted already.
6. **Labels:** `needs-review` is created by `issue.request-review` when missing. Create `no-agent`
   yourself if you want to keep some issues away from agents.
7. **Ruleset on `main`:** on GitHub, protect the default branch with a ruleset that only accepts
   changes through pull requests, blocks force pushes and blocks deletion. Merging stays the
   human's.
8. **Launch the coordinator:** `coordinator.launch` from the Space menu, or
   `opencove plugin run github-issues coordinator.launch --params '{"projectId":"<id>"}'`.
