// agents.status: one row per issue task, with the linked agent's runtime and observed state.
import { mapSeries } from './sequence.mjs'
import { issueTagOf, listTaskNodes, parseIssueTag } from './tasks.mjs'

const AGENT_STATES = new Set(['working', 'waiting', 'done'])

export async function collectAgentStatus(host, projectIds) {
  const rows = await mapSeries(projectIds, projectId => statusForProject(host, projectId))
  return rows.flat()
}

async function statusForProject(host, projectId) {
  const tasks = (await listTaskNodes(host, projectId)).flatMap(task => {
    const tag = issueTagOf(task.data.tags)
    return tag ? [{ task, tag, issue: parseIssueTag(tag) }] : []
  })
  if (tasks.length === 0) {
    return []
  }
  const agents = await listAgentDetails(host, projectId)
  return mapSeries(tasks, async ({ task, issue }) => {
    const agent = findAgentForTask(agents, task, issue)
    return {
      issue: `${issue.repo}#${issue.number}`,
      repo: issue.repo,
      number: issue.number,
      projectId,
      taskNodeId: task.id,
      taskStatus: task.data.status ?? null,
      agentNodeId: agent?.id ?? null,
      runtimeStatus: agent?.status ?? null,
      agentState: agent ? await agentStateOf(host, agent.id) : null,
    }
  })
}

async function listAgentDetails(host, projectId) {
  const listed = await host.nodes.list({ projectId, kind: 'agent' })
  return mapSeries(listed.nodes ?? [], async node => {
    const detail = await host.nodes.get({ nodeId: node.id })
    const data = detail?.node?.data ?? {}
    return {
      id: node.id,
      title: node.title ?? '',
      status: node.status ?? null,
      prompt: typeof data.prompt === 'string' ? data.prompt : '',
    }
  })
}

// The link is stored by core #6: task.linkedAgentNodeId is the source of truth.
function findAgentForTask(agents, task, issue) {
  const linkedId = task.data.linkedAgentNodeId
  if (typeof linkedId === 'string' && linkedId.length > 0) {
    return agents.find(agent => agent.id === linkedId) ?? { id: linkedId, status: null }
  }
  return legacyAgentForTask(agents, task, issue)
}

// LEGACY: tasks created by #5 before core #6 have no stored link. Match by the issue requirement
// in the agent prompt, or by the task title. Only used when linkedAgentNodeId is absent; the
// last match wins (a relaunch). Remove once no unlinked issue task remains.
function legacyAgentForTask(agents, task, issue) {
  const header = `github issue ${issue.repo}#${issue.number} at `
  const matches = agents.filter(
    agent =>
      agent.prompt.toLowerCase().includes(header) ||
      (agent.title.length > 0 && agent.title === task.title),
  )
  return matches.at(-1) ?? null
}

// A failed read is not evidence either way, so it reports null rather than failing the listing.
async function agentStateOf(host, nodeId) {
  try {
    const state = (await host.agents.get({ nodeId }))?.agentState
    return AGENT_STATES.has(state) ? state : null
  } catch {
    return null
  }
}
