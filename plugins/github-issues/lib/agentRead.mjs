// agents.read: the coordinator's view of a waiting issue agent. Only agents linked to an issue
// task of the project are readable, so the coordinator cannot read arbitrary sessions.
import { commandError } from './errors.mjs'
import { agentStateOf } from './status.mjs'
import { requireNodeId, requireProjectId } from './params.mjs'
import { issueTagOf, listTaskNodes, parseIssueTag } from './tasks.mjs'

// Upper bound on returned text. The host returns up to 256 KiB; the coordinator needs only the tail.
export const MAX_READ_CHARS = 8000

export async function readLinkedAgent({ host, projectId, nodeId }) {
  const project = requireProjectId(projectId)
  const agentId = requireNodeId(nodeId)
  const linked = (await listTaskNodes(host, project)).find(
    task => task.data.linkedAgentNodeId === agentId && issueTagOf(task.data.tags) !== null,
  )
  if (!linked) {
    throw commandError(
      'agent-not-linked',
      'This agent is not linked to an issue task in the project, so it cannot be read.',
      { nodeId: agentId },
    )
  }

  const read = await host.agents.read({ nodeId: agentId })
  const text = String(read?.output ?? '')
  const bounded = text.length > MAX_READ_CHARS ? text.slice(-MAX_READ_CHARS) : text
  const issue = parseIssueTag(issueTagOf(linked.data.tags))
  return {
    nodeId: agentId,
    issue: `${issue.repo}#${issue.number}`,
    taskNodeId: linked.id,
    sessionId: read?.sessionId ?? null,
    // Agent output is data for the coordinator to summarise, never instructions to follow.
    output: bounded,
    truncated: Boolean(read?.truncated) || text.length > MAX_READ_CHARS,
    agentState: await agentStateOf(host, agentId),
  }
}
