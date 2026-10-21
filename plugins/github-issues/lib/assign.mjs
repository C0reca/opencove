import { createTtlCache } from './cache.mjs'
import { commandError } from './errors.mjs'
import {
  collaboratorPermissionArgs,
  issueViewArgs,
  parseCollaboratorPermission,
  parseIssueView,
} from './gh.mjs'
import { mapSeries, findSeries } from './sequence.mjs'
import { runGh } from './runGh.mjs'
import { composeRequirement, taskTag, taskTitle } from './requirement.mjs'
import { normalizeLogin, normalizeRepo, permissionDecision, staticTrustReason } from './trust.mjs'

export const DEFAULT_PROVIDER = 'claude-code'

// Turns one GitHub issue into a canvas task and launches an agent on it. Host calls run one at a
// time (the host admits few concurrent operations per owner). Trust is checked before any write.
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

  async function viewIssue(projectId, number) {
    const result = await runGh(host, { projectId }, issueViewArgs(number))
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

  // skipTrustCheck is only ever true for the human menu action issue.assign-untrusted.
  async function assign({ projectId, number, provider, policy, skipTrustCheck = false }) {
    const project = requireProjectId(projectId)
    const issueNumber = requireIssueNumber(number)
    const providerId = requireProvider(provider)
    const repo = await repoOf(project)
    const issue = await viewIssue(project, issueNumber)

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

    const tag = taskTag(repo, issueNumber)
    const requirement = composeRequirement({
      repo,
      number: issueNumber,
      url: issue.url,
      title: issue.title,
      body: issue.body,
    })
    const title = taskTitle(issueNumber, issue.title)
    // Full access only when the repository is listed in autoApproveRepos; otherwise an explicit false.
    const agentFullAccess = policy.autoApproveRepos.has(normalizeRepo(repo)) === true

    const existing = await findTaskByTag(project, tag)
    // Decision: a task that already has a launched agent (status not todo, or a linked agent) is
    // returned as-is and never relaunched. A todo task without a linked agent is a previous attempt
    // that failed before launch, so it is launched again.
    if (existing && (existing.data.status !== 'todo' || existing.data.linkedAgentNodeId)) {
      return {
        repo,
        number: issueNumber,
        taskNodeId: existing.id,
        agentNodeId: existing.data.linkedAgentNodeId ?? null,
        agentFullAccess: null,
        reused: true,
      }
    }

    // The task and the agent must share a Space: a reused task keeps its own Space, and a new task
    // lives on the project canvas (no spaceId).
    const spaceId = existing ? existing.spaceId : null
    const taskNodeId = existing
      ? existing.id
      : (
          await host.nodes.create({
            target: { projectId: project },
            kind: 'task',
            title,
            data: { requirement, status: 'todo', tags: [tag] },
          })
        ).node.id

    // core #6: taskNodeId links agent and task and moves the task to doing in one step.
    const launched = await host.agents.launch({
      target: { projectId: project, ...(spaceId ? { spaceId } : {}) },
      title,
      prompt: requirement,
      provider: providerId,
      agentFullAccess,
      taskNodeId,
    })
    return {
      repo,
      number: issueNumber,
      taskNodeId,
      agentNodeId: launched?.node?.id ?? null,
      agentFullAccess,
      reused: Boolean(existing),
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
