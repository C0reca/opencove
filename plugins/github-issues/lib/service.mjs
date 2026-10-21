import { createTtlCache } from './cache.mjs'
import { commandError } from './errors.mjs'
import { issueListArgs, parseIssueList, parseRepoView, REPO_VIEW_ARGS } from './gh.mjs'
import { buildReport, groupLookupsByRepo } from './report.mjs'
import { runGh } from './runGh.mjs'

// Reads GitHub issues through gh for one or many projects. Host calls run one at a time because
// the host admits only a few concurrent operations per owner; the 60 s caches keep reads cheap.
export function createIssueService({ host, ttlMs, now }) {
  const repoCache = createTtlCache({ ttlMs, now })
  const issueCache = createTtlCache({ ttlMs, now })

  async function lookupProject(projectId, refresh) {
    const cached = refresh ? undefined : repoCache.get(projectId)
    if (cached) {
      return cached
    }

    const result = await runGh(host, { projectId }, REPO_VIEW_ARGS)
    let lookup
    if (!result.ok) {
      lookup = { projectId, repo: null, error: result.error }
    } else {
      try {
        lookup = { projectId, repo: parseRepoView(result.output), error: null }
      } catch (caught) {
        lookup = { projectId, repo: null, error: { code: 'gh-failed', message: messageOf(caught) } }
      }
    }
    repoCache.set(projectId, lookup)
    return lookup
  }

  // The first project of a repository supplies the working directory for gh.
  async function fetchRepoIssues(repo, projectId, refresh) {
    const cached = refresh ? undefined : issueCache.get(repo)
    if (cached) {
      return { ok: true, issues: cached }
    }

    const result = await runGh(host, { projectId }, issueListArgs())
    if (!result.ok) {
      return result
    }
    try {
      const issues = parseIssueList(result.output)
      issueCache.set(repo, issues)
      return { ok: true, issues }
    } catch (caught) {
      return { ok: false, error: { code: 'gh-failed', message: messageOf(caught) } }
    }
  }

  // Returns the report { repos, errors } for an explicit list of project IDs.
  async function list({ projectIds, refresh = false }) {
    const lookups = await mapSeries(projectIds, projectId => lookupProject(projectId, refresh))
    const groups = groupLookupsByRepo(lookups)
    const entries = await mapSeries(groups.repos, async group => [
      group.repo,
      await fetchRepoIssues(group.repo, group.projectIds[0], refresh),
    ])
    return buildReport(groups, new Map(entries))
  }

  async function listAllProjects({ refresh = false } = {}) {
    const catalog = await host.target.list()
    const projectIds = (catalog.projects ?? []).map(project => project.id)
    return list({ projectIds, refresh })
  }

  // Resolves a project's owner/repo through the same cache; throws a coded error when unknown.
  async function repoForProject(projectId) {
    const lookup = await lookupProject(projectId, false)
    if (lookup.repo) {
      return lookup.repo
    }
    throw commandError(
      lookup.error?.code ?? 'gh-failed',
      lookup.error?.message ?? 'The project repository is unknown.',
    )
  }

  return { list, listAllProjects, repoForProject }
}

function mapSeries(items, mapper) {
  return items.reduce(async (previous, item) => {
    const done = await previous
    done.push(await mapper(item))
    return done
  }, Promise.resolve([]))
}

function messageOf(caught) {
  return caught instanceof Error ? caught.message : String(caught)
}
