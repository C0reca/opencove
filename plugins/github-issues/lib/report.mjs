// Pure report shaping: group project lookups by repository and build Sidebar items.
// Every error keeps the projectIds it affects, so one failing project never hides the others.

// lookups: [{ projectId, repo: string | null, error: { code, message } | null }]
export function groupLookupsByRepo(lookups) {
  const byRepo = new Map()
  const errors = []

  for (const lookup of lookups) {
    if (lookup.repo) {
      const group = byRepo.get(lookup.repo) ?? { repo: lookup.repo, projectIds: [] }
      group.projectIds.push(lookup.projectId)
      byRepo.set(lookup.repo, group)
    } else {
      errors.push({
        projectIds: [lookup.projectId],
        repo: null,
        code: lookup.error?.code ?? 'gh-failed',
        message: lookup.error?.message ?? 'Unknown error',
      })
    }
  }

  return { repos: [...byRepo.values()], errors }
}

// repoIssues: Map<repo, { ok: true, issues } | { ok: false, error: { code, message } }>
export function buildReport(groups, repoIssues) {
  const repos = []
  const errors = [...groups.errors]

  for (const group of groups.repos) {
    const result = repoIssues.get(group.repo)
    if (result?.ok) {
      repos.push({ repo: group.repo, projectIds: group.projectIds, issues: result.issues })
    } else {
      errors.push({
        projectIds: group.projectIds,
        repo: group.repo,
        code: result?.error?.code ?? 'gh-failed',
        message: result?.error?.message ?? 'Unknown error',
      })
    }
  }

  return { repos, errors }
}

// Sidebar tree for one project, derived from a report that contains it.
// isTrusted(author) decides whether an issue may be assigned by the plain command;
// autoApprove puts a visible warning first, because the agents launched here skip prompts.
export function sidebarItemsForProject(
  report,
  projectId,
  { isTrusted = () => false, autoApprove = false } = {},
) {
  const refresh = {
    id: 'refresh',
    label: 'Refresh issues',
    command: { id: 'issues.refresh', params: { projectId } },
  }

  const repo = report.repos.find(entry => entry.projectIds.includes(projectId))
  if (repo) {
    const warning = autoApprove
      ? [
          {
            id: 'auto-approve-warning',
            label: '⚠ Auto-approve ON: agents run without permission prompts',
          },
        ]
      : []
    if (repo.issues.length === 0) {
      return { items: [...warning, { id: 'empty', label: 'No open issues' }, refresh] }
    }
    return {
      items: [
        ...warning,
        ...repo.issues.map(issue => issueSidebarItem(issue, projectId, isTrusted(issue.author))),
        refresh,
      ],
    }
  }

  const error = report.errors.find(entry => entry.projectIds.includes(projectId))
  return {
    items: [
      {
        id: 'status',
        label: error?.message ?? 'Issues are unavailable for this project',
        description: error?.code,
      },
      refresh,
    ],
  }
}

// Trusted issues assign with the plain command; others only with the human-only menu action.
function issueSidebarItem(issue, projectId, trusted) {
  const labels = issue.labels.join(', ')
  const description = trusted
    ? labels
    : [`⚠ untrusted author: ${issue.author ?? 'unknown'}`, labels].filter(Boolean).join(' · ')
  const command = trusted ? 'issue.assign' : 'issue.assign-untrusted'
  return {
    id: `issue-${issue.number}`,
    label: `#${issue.number} ${issue.title}`,
    ...(description ? { description } : {}),
    command: { id: command, params: { projectId, number: issue.number } },
  }
}
