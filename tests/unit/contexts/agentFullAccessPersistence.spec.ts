import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import type {
  TerminalNodeData,
  WorkspaceState,
} from '@contexts/workspace/presentation/renderer/types'
import { toPersistedState } from '@contexts/workspace/presentation/renderer/utils/persistence/toPersistedState'
import { ensurePersistedWorkspace } from '@contexts/workspace/presentation/renderer/utils/persistence/ensure'
import { toRuntimeNodes } from '@contexts/workspace/presentation/renderer/utils/nodeTransform'
import { normalizePersistedAppState } from '@platform/persistence/sqlite/normalize'
import { isPersistedNode } from '@shared/sync/persistedNodeValidation'
import { resolveAgentPermissionMode } from '@shared/utils/agentPermissionMode'

function agentNode(agent: Record<string, unknown>): Node<TerminalNodeData> {
  return {
    id: 'agent-1',
    type: 'terminalNode',
    position: { x: 0, y: 0 },
    data: {
      sessionId: '',
      title: 'Agent',
      width: 520,
      height: 360,
      kind: 'agent',
      status: 'standby',
      startedAt: '2026-05-01T00:00:00.000Z',
      endedAt: null,
      exitCode: null,
      lastError: null,
      scrollback: null,
      agent: {
        provider: 'claude-code',
        prompt: '',
        model: null,
        effectiveModel: null,
        launchMode: 'new',
        resumeSessionId: null,
        resumeSessionIdVerified: false,
        executionDirectory: '/repo',
        expectedDirectory: '/repo',
        directoryMode: 'workspace',
        customDirectory: null,
        shouldCreateDirectory: false,
        taskId: null,
        ...agent,
      } as TerminalNodeData['agent'],
      task: null,
    },
  }
}

function workspace(node: Node<TerminalNodeData>): WorkspaceState {
  return {
    id: 'workspace',
    name: 'Workspace',
    path: '/repo',
    worktreesRoot: '',
    nodes: [node],
    viewport: { x: 0, y: 0, zoom: 1 },
    isMinimapVisible: true,
    spaces: [],
    activeSpaceId: null,
    spaceArchiveRecords: [],
  }
}

function persistedNode(node: Node<TerminalNodeData>) {
  // Durable path: renderer state -> persisted JSON (as stored in agent_json) -> parsed again.
  return JSON.parse(JSON.stringify(toPersistedState([workspace(node)], 'workspace')))
}

function restoreNode(persisted: ReturnType<typeof persistedNode>) {
  const normalized = normalizePersistedAppState(persisted)
  const restored = ensurePersistedWorkspace(normalized?.workspaces[0])!
  const [restoredNode] = toRuntimeNodes(restored)
  return restoredNode
}

describe('agent node persisted agentFullAccess', () => {
  it.each([true, false])('round-trips an explicit agentFullAccess=%s', value => {
    const persisted = persistedNode(agentNode({ agentFullAccess: value }))

    expect(isPersistedNode(persisted.workspaces[0].nodes[0])).toBe(true)
    expect(restoreNode(persisted).data.agent).toMatchObject({ agentFullAccess: value })
  })

  it('reads legacy agent data without the field and keeps it absent', () => {
    const persisted = persistedNode(agentNode({}))

    expect(isPersistedNode(persisted.workspaces[0].nodes[0])).toBe(true)
    const restoredAgent = restoreNode(persisted).data.agent as Record<string, unknown>
    expect(restoredAgent).not.toHaveProperty('agentFullAccess')
    expect(restoredAgent).toMatchObject({ provider: 'claude-code', executionDirectory: '/repo' })
  })

  it('rejects a non-boolean agentFullAccess as a persisted node shape', () => {
    const persisted = persistedNode(agentNode({}))
    persisted.workspaces[0].nodes[0].agent.agentFullAccess = 'false'

    expect(isPersistedNode(persisted.workspaces[0].nodes[0])).toBe(false)
  })
})

describe('agent node persisted agentPermissionMode', () => {
  it.each(['default', 'auto', 'full'])('round-trips an explicit agentPermissionMode=%s', value => {
    const persisted = persistedNode(agentNode({ agentPermissionMode: value }))

    expect(isPersistedNode(persisted.workspaces[0].nodes[0])).toBe(true)
    expect(restoreNode(persisted).data.agent).toMatchObject({ agentPermissionMode: value })
  })

  it('keeps legacy agentFullAccess-only nodes readable and resolvable', () => {
    const restored = restoreNode(persistedNode(agentNode({ agentFullAccess: false })))
    const agent = restored.data.agent as Record<string, unknown>

    expect(agent).not.toHaveProperty('agentPermissionMode')
    expect(agent).toMatchObject({ agentFullAccess: false, provider: 'claude-code' })
    expect(resolveAgentPermissionMode(agent, true)).toBe('default')
  })

  it('keeps both fields when present, the mode winning on resolution', () => {
    const restored = restoreNode(
      persistedNode(agentNode({ agentPermissionMode: 'auto', agentFullAccess: true })),
    )
    const agent = restored.data.agent as Record<string, unknown>

    expect(agent).toMatchObject({ agentPermissionMode: 'auto', agentFullAccess: true })
    expect(resolveAgentPermissionMode(agent, false)).toBe('auto')
  })

  it('rejects an unknown agentPermissionMode as a persisted node shape', () => {
    const persisted = persistedNode(agentNode({}))
    persisted.workspaces[0].nodes[0].agent.agentPermissionMode = 'bypass'

    expect(isPersistedNode(persisted.workspaces[0].nodes[0])).toBe(false)
  })
})
