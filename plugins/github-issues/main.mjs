import { createAssignService } from './lib/assign.mjs'
import { createClosingService } from './lib/closing.mjs'
import { launchCoordinator } from './lib/coordinator.mjs'
import { commandError } from './lib/errors.mjs'
import { readLinkedAgent } from './lib/agentRead.mjs'
import { collectAgentStatus } from './lib/status.mjs'
import { sidebarItemsForProject } from './lib/report.mjs'
import { createIssueService } from './lib/service.mjs'
import { normalizeLogin, normalizeRepo, readTrustPolicy } from './lib/trust.mjs'

// Thin wiring: parameter checks and command routing. Logic lives in lib/.
export async function activate(context) {
  const host = context.host
  const service = createIssueService({ host })
  const assigner = createAssignService({ host, repoOf: service.repoForProject })
  const closing = createClosingService({ host, repoOf: service.repoForProject })

  return {
    async runCommand(commandId, rawParams, commandContext) {
      const params = rawParams ?? {}
      const projectId = resolveProjectId(params, commandContext)
      const refresh = params.refresh === true

      switch (commandId) {
        case 'issues.list':
          if (projectId) {
            return service.list({ projectIds: [projectId], refresh })
          }
          return service.listAllProjects({ refresh })
        case 'issues.refresh':
          return service.list({ projectIds: requireProject(projectId), refresh: true })
        case 'issues.sidebar':
          return sidebarFor({ projectId, refresh, commandContext })
        case 'issue.assign':
          return assignIssue({ params, projectId, commandContext, skipTrustCheck: false })
        case 'issue.assign-untrusted':
          // Human-only: a menu invocation carries host context; a CLI run never does.
          if (!commandContext?.host) {
            throw commandError(
              'human-only',
              'issue.assign-untrusted is a Sidebar menu action; it cannot run from the CLI.',
            )
          }
          return assignIssue({ params, projectId, commandContext, skipTrustCheck: true })
        case 'coordinator.launch': {
          if (!projectId) {
            throw commandError('invalid-params', 'projectId is required')
          }
          const spaceId = commandContext?.host?.spaceId
          return launchCoordinator({
            host,
            projectId,
            spaceId: typeof spaceId === 'string' && spaceId.length > 0 ? spaceId : undefined,
          })
        }
        case 'agents.read':
          return readLinkedAgent({ host, projectId, nodeId: params.nodeId })
        case 'agents.status': {
          const projectIds = projectId ? [projectId] : await allProjectIds()
          return { issues: await collectAgentStatus(host, projectIds) }
        }
        case 'issue.close':
          return closing.close({
            projectId,
            number: params.number,
            pr: params.pr,
            evidence: params.evidence,
          })
        case 'issue.request-review':
          return closing.requestReview({
            projectId,
            number: params.number,
            summary: params.summary,
            evidence: params.evidence,
          })
        case 'issue.close-manual':
          // Human-only: same guard as issue.assign-untrusted.
          if (!commandContext?.host) {
            throw commandError(
              'human-only',
              'issue.close-manual is a Sidebar menu action; it cannot run from the CLI.',
            )
          }
          return closing.closeManual({
            projectId,
            number: params.number,
            reason: params.reason,
          })
        default:
          throw new Error(`Unknown command: ${commandId}`)
      }
    },
    async dispose() {
      context.log('GitHub Issues stopped')
    },
  }

  async function allProjectIds() {
    const catalog = await host.target.list()
    return (catalog.projects ?? []).map(project => project.id)
  }

  async function preferencesOf(commandContext) {
    return commandContext?.preferences ?? (await host.preferences.get()) ?? {}
  }

  async function sidebarFor({ projectId, refresh, commandContext }) {
    const report = await service.list({ projectIds: requireProject(projectId), refresh })
    const entry = report.repos.find(item => item.projectIds.includes(projectId))
    if (!entry) {
      return sidebarItemsForProject(report, projectId)
    }
    const policy = readTrustPolicy(await preferencesOf(commandContext))
    const verdicts = await assigner.trustAuthors({
      projectId,
      repo: entry.repo,
      authors: entry.issues.map(issue => issue.author),
      policy,
    })
    return sidebarItemsForProject(report, projectId, {
      isTrusted: author => verdicts.get(normalizeLogin(author)) === true,
      autoApprove: policy.autoApproveRepos.has(normalizeRepo(entry.repo)) === true,
    })
  }

  async function assignIssue({ params, projectId, commandContext, skipTrustCheck }) {
    if (!projectId) {
      throw commandError('invalid-params', 'projectId is required')
    }
    return assigner.assign({
      projectId,
      number: params.number,
      provider: params.provider,
      policy: readTrustPolicy(await preferencesOf(commandContext)),
      skipTrustCheck,
      worktree: params.worktree,
      parentSpaceId: params.parentSpaceId,
    })
  }
}

// Explicit params win; the sidebar's host context is the fallback for project-scoped commands.
function resolveProjectId(params, commandContext) {
  const explicit = params.projectId ?? commandContext?.host?.projectId
  if (explicit === undefined || explicit === null) {
    return undefined
  }
  if (typeof explicit !== 'string' || explicit.length === 0) {
    throw new Error('projectId must be a non-empty string')
  }
  return explicit
}

function requireProject(projectId) {
  if (!projectId) {
    throw new Error('projectId is required')
  }
  return [projectId]
}
