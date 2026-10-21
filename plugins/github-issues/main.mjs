import { sidebarItemsForProject } from './lib/report.mjs'
import { createIssueService } from './lib/service.mjs'

// Thin wiring: parameter checks and command routing. Logic lives in lib/.
export async function activate(context) {
  const service = createIssueService({ host: context.host })

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
        case 'issues.sidebar': {
          const report = await service.list({ projectIds: requireProject(projectId), refresh })
          return sidebarItemsForProject(report, projectId)
        }
        default:
          throw new Error(`Unknown command: ${commandId}`)
      }
    },
    async dispose() {
      context.log('GitHub Issues stopped')
    },
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
