import { createTtlCache } from './cache.mjs'
import { writeAgentGuard } from './agentSettings.mjs'
import { commandError } from './errors.mjs'
import {
  collaboratorPermissionArgs,
  issueViewArgs,
  NO_AGENT_LABEL,
  parseCollaboratorPermission,
  parseIssueView,
} from './gh.mjs'
import { mapSeries, findSeries } from './sequence.mjs'
import { runGh } from './runGh.mjs'
import { composeRequirement, taskTag, taskTitle } from './requirement.mjs'
import { corePermissionMode, maxAgentsFor, permissionModeFor } from './permissions.mjs'
import { effectiveModeFor } from './locality.mjs'
import { collectAgentStatus } from './status.mjs'
import {
  createIssueWorktree,
  issueSpaceName,
  resolveRootSpace,
  targetWorkingDirectory,
} from './worktree.mjs'
import { normalizeLogin, normalizeRepo, permissionDecision, staticTrustReason } from './trust.mjs'

export const DEFAULT_PROVIDER = 'claude-code'

// Turns one GitHub issue into a canvas task in its own worktree and launches an agent on it.
// Host calls run one at a time (the host admits few concurrent operations per owner).
// Trust is checked before any write; the guard file is written before the agent launches.
export function createAssignService({ host, repoOf, ttlMs, now }) {
  // Caches only real permission answers; a failed lookup is retried, which keeps trust fail-closed.
  const permissionCache = createTtlCache({ ttlMs, now })

  async function lookupPermission(projectId, repo, login) {
    if (!/^[a-z0-9-]+$/.test(login)) {
      return null
    }
    const result = await runGh(host, { projectId }, collaboratorPermissionArgs(repo, login))
    if (!result.ok) {
      return null
    }
    try {
      return parseCollaboratorPermission(result.output)
    } catch {
      return null
    }
  }

  async function trustOf({ projectId, repo, author, policy }) {
    const decided = staticTrustReason({ author, repo, trustedAuthors: policy.trustedAuthors })
    if (decided) {
      return decided
    }
    const slug = normalizeRepo(repo)
    const login = normalizeLogin(author)
    const key = `${slug}|${login}`
    let permission = permissionCache.get(key)
    if (permission === undefined) {
      permission = await lookupPermission(projectId, slug, login)
      if (permission !== null) {
        permissionCache.set(key, permission)
      }
    }
    return permissionDecision(permission)
  }

  // Sidebar helper: one verdict per distinct author, keyed by lowercase login.
  async function trustAuthors({ projectId, repo, authors, policy }) {
    const logins = [...new Set(authors.map(normalizeLogin))].filter(Boolean)
    const verdicts = await mapSeries(logins, async login => [
      login,
      (await trustOf({ projectId, repo, author: login, policy })).trusted,
    ])
    return new Map(verdicts)
  }

  async function viewIssue(projectId, repo, number) {
    const result = await runGh(host, { projectId }, issueViewArgs(number), { repo })
    if (!result.ok) {
      throw commandError(result.error.code, result.error.message, { number })
    }
    try {
      return parseIssueView(result.output)
    } catch (caught) {
      throw commandError('gh-failed', messageOf(caught), { number })
    }
  }

  // Idempotency key: the task tag. Lists task nodes, then reads each one for its tags.
  async function findTaskByTag(projectId, tag) {
    const listed = await host.nodes.list({ projectId, kind: 'task' })
    if (listed.truncated) {
      throw commandError(
        'too-many-tasks',
        'The project has too many task nodes to check for an existing task safely.',
      )
    }
    return findSeries(listed.nodes ?? [], async node => {
      const data = (await host.nodes.get({ nodeId: node.id }))?.node?.data
      const tags = Array.isArray(data?.tags) ? data.tags : []
      if (data?.kind === 'task' && tags.some(value => String(value).toLowerCase() === tag)) {
        return { id: node.id, data, spaceId: node.spaceId ?? null }
      }
      return null
    })
  }

  // Counts the project's active issue agents as the coordinator skill does (working or waiting, or a
  // running runtime status), and refuses a new launch at the limit. Nothing is written before this.
  async function requireBelowLimit({ projectId, repo, limits }) {
    const limit = maxAgentsFor(limits, repo)
    const rows = await collectAgentStatus(host, [projectId])
    const active = rows.filter(
      row =>
        row.agentState === 'working' ||
        row.agentState === 'waiting' ||
        row.runtimeStatus === 'running',
    ).length
    if (active >= limit) {
      throw commandError(
        'limit-reached',
        `${repo} already has ${active} issue agent(s) running and the limit is ${limit} (max-agents). Nothing was launched; assign again when one finishes, or raise the limit.`,
        { repo, active, limit },
      )
    }
  }

  // skipTrustCheck and humanMenu are only ever true for the human menu actions. The CLI never sets them.
  async function assign({
    projectId,
    number,
    provider,
    policy,
    skipTrustCheck = false,
    humanMenu = false,
    worktree,
    parentSpaceId,
  }) {
    const project = requireProjectId(projectId)
    const issueNumber = requireIssueNumber(number)
    const providerId = requireProvider(provider)
    requireWorktreeFlag(worktree)
    const repo = await repoOf(project)
    const issue = await viewIssue(project, repo, issueNumber)

    if (!skipTrustCheck) {
      const verdict = await trustOf({ projectId: project, repo, author: issue.author, policy })
      if (!verdict.trusted) {
        throw commandError(
          'untrusted-author',
          `Issue ${repo}#${issueNumber} was opened by ${issue.author ?? 'an unknown user'}, who is not trusted for ${repo} (${verdict.reason}). Assign it from the sidebar with the untrusted-author action if you still want to.`,
          { repo, number: issueNumber, author: issue.author, reason: verdict.reason },
        )
      }
    }
    // Decision: the coordinator skips no-agent issues. Only a person's menu action assigns them.
    if (issue.labels.includes(NO_AGENT_LABEL) && !humanMenu) {
      throw commandError(
        'no-agent',
        `Issue ${repo}#${issueNumber} is labelled ${NO_AGENT_LABEL}, so agents are not assigned to it. A person can assign it from the sidebar.`,
        { repo, number: issueNumber },
      )
    }

    const tag = taskTag(repo, issueNumber)
    const requirement = composeRequirement({
      repo,
      number: issueNumber,
      url: issue.url,
      title: issue.title,
      body: issue.body,
    })
    const title = taskTitle(issueNumber, issue.title)
    const configuredMode = permissionModeFor(policy.permissionModes, repo)

    const existing = await findTaskByTag(project, tag)
    // Decision: a task that already has a launched agent (status not todo, or a linked agent) is
    // returned as-is and never relaunched. A todo task without a linked agent is a previous attempt
    // that failed before launch, so it is launched again in the Space it already has.
    if (existing && (existing.data.status !== 'todo' || existing.data.linkedAgentNodeId)) {
      return {
        repo,
        number: issueNumber,
        taskNodeId: existing.id,
        agentNodeId: existing.data.linkedAgentNodeId ?? null,
        configuredMode: null,
        effectiveMode: null,
        reason: null,
        agentPermissionMode: null,
        reused: true,
      }
    }
    // Decision: a todo task on the project canvas has no worktree, and every issue agent needs one.
    // It is refused rather than moved, so nothing runs outside a worktree.
    if (existing && !existing.spaceId) {
      throw commandError(
        'task-not-in-worktree',
        `The task for ${repo}#${issueNumber} is on the project canvas, not in a worktree. Remove that task, then assign the issue again.`,
        { repo, number: issueNumber, taskNodeId: existing.id },
      )
    }

    // Decision: max-agents caps new launches for the CLI only. The human Sidebar menu bypasses it:
    // a person starting an agent on purpose overrides the throttle; the coordinator is held to it.
    if (!humanMenu) {
      await requireBelowLimit({ projectId: project, repo, limits: policy.maxAgents })
    }

    // Every issue agent runs in its own worktree Space. A relaunched task keeps its Space.
    let spaceId = existing ? existing.spaceId : null
    let branch = null
    if (!spaceId) {
      const rootSpaceId = await resolveRootSpace(host, project, {
        explicitParentSpaceId: requireParentSpaceId(parentSpaceId),
      })
      const made = await createIssueWorktree({
        host,
        projectId: project,
        rootSpaceId,
        name: issueSpaceName(issueNumber, issue.title),
      })
      spaceId = made.spaceId
      branch = made.branch
    }

    try {
      const target = { projectId: project, spaceId }
      // The guard is written before the task and the agent exist, so the agent never starts without it.
      await writeAgentGuard({
        host,
        projectId: project,
        spaceId,
        root: await targetWorkingDirectory(host, target),
      })
      // Local-only autonomy: auto and full apply to a local target; anything else runs in normal.
      const decision = await effectiveModeFor(host, target, configuredMode)
      const taskNodeId = existing
        ? existing.id
        : (
            await host.nodes.create({
              target,
              kind: 'task',
              title,
              data: { requirement, status: 'todo', tags: [tag] },
            })
          ).node.id

      // core #6: taskNodeId links agent and task and moves the task to doing in one step.
      const launched = await host.agents.launch({
        target,
        title,
        prompt: requirement,
        provider: providerId,
        agentPermissionMode: corePermissionMode(decision.effectiveMode),
        taskNodeId,
      })
      return {
        repo,
        number: issueNumber,
        taskNodeId,
        agentNodeId: launched?.node?.id ?? null,
        configuredMode: decision.configuredMode,
        effectiveMode: decision.effectiveMode,
        reason: decision.reason,
        agentPermissionMode: corePermissionMode(decision.effectiveMode),
        spaceId,
        branch,
        reused: Boolean(existing),
      }
    } catch (caught) {
      // Partial failure: the Space and branch exist. Report them; nothing is deleted.
      if (branch) {
        throw commandError(
          caught?.code ?? 'launch-failed',
          `${messageOf(caught)} The Space ${spaceId} and branch ${branch} were created and are kept; remove them manually if they are not wanted.`,
          { ...(caught?.details ?? {}), spaceId, branch },
        )
      }
      throw caught
    }
  }

  return { assign, trustAuthors }
}

function requireProjectId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw commandError('invalid-params', 'projectId must be a non-empty string')
  }
  return value
}

function requireIssueNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw commandError('invalid-params', 'number must be a positive integer')
  }
  return value
}

// Optional explicit root Space for worktrees.
function requireParentSpaceId(value) {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw commandError(
      'invalid-params',
      'parentSpaceId must be a non-empty string of at most 200 characters',
    )
  }
  return value
}

// Decision: every issue agent runs in a worktree. The old `worktree` choice is gone, so only
// omitting it or passing true is accepted; false is refused rather than silently ignored.
function requireWorktreeFlag(value) {
  if (value === undefined || value === null || value === true) {
    return
  }
  throw commandError(
    'invalid-params',
    'every issue agent runs in its own worktree; worktree can only be omitted or true',
  )
}

function requireProvider(value) {
  if (value === undefined || value === null) {
    return DEFAULT_PROVIDER
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw commandError('invalid-params', 'provider must be a non-empty string')
  }
  return value
}

function messageOf(caught) {
  return caught instanceof Error ? caught.message : String(caught)
}
