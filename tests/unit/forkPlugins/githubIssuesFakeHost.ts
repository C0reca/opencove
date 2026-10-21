// Fake host for the github-issues backend. gh calls are answered by the test; canvas nodes,
// agent launches and preferences are kept in memory so tests can read back every side effect.

export type GhReply = { status?: string; exitCode?: number; output?: string; error?: string }

export interface FakeNode {
  id: string
  kind: string
  title: string
  data: { kind: string; tags?: string[]; status?: string; linkedAgentNodeId?: string | null }
}

export interface FakeHostOptions {
  gh: (args: string[]) => GhReply
  prefs?: Record<string, string>
  nodes?: FakeNode[]
}

export const ok = (output: string): GhReply => ({ status: 'completed', exitCode: 0, output })
export const failed = (error: string): GhReply => ({ status: 'completed', exitCode: 1, error })

export function createFakeHost({ gh, prefs = {}, nodes: seeded = [] }: FakeHostOptions) {
  const ghCalls: string[][] = []
  const launches: Array<Record<string, unknown>> = []
  const created: FakeNode[] = []
  const updates: Array<{ nodeId: string; data: Record<string, unknown> }> = []
  const nodes = new Map<string, FakeNode>(seeded.map(node => [node.id, node]))
  const operations = new Map<string, GhReply>()
  let sequence = 0

  const host = {
    target: {
      list: async () => ({ projects: [{ id: 'p1', name: 'p1', spaces: [] }] }),
    },
    operations: {
      start: async ({ args }: { args: string[] }) => {
        ghCalls.push(args)
        const operationId = `op-${++sequence}`
        operations.set(operationId, gh(args))
        return { operationId, status: 'running' }
      },
      get: async ({ operationId }: { operationId: string }) => {
        const reply = operations.get(operationId) ?? {}
        return {
          operationId,
          status: reply.status ?? 'completed',
          exitCode: reply.exitCode ?? 0,
          output: reply.output ?? '',
          error: reply.error ?? '',
        }
      },
      cancel: async () => ({}),
    },
    nodes: {
      list: async ({ kind }: { kind?: string }) => ({
        nodes: [...nodes.values()].filter(node => node.kind === kind),
        truncated: false,
      }),
      get: async ({ nodeId }: { nodeId: string }) => ({ node: nodes.get(nodeId) }),
      create: async ({ kind, title, data }: { kind: string; title: string; data: object }) => {
        const node: FakeNode = {
          id: `task-${++sequence}`,
          kind,
          title,
          data: { kind, ...data },
        }
        nodes.set(node.id, node)
        created.push(node)
        return { node }
      },
      update: async ({ nodeId, data }: { nodeId: string; data: Record<string, unknown> }) => {
        const node = nodes.get(nodeId)
        if (!node) {
          throw new Error(`no node ${nodeId}`)
        }
        node.data = { ...node.data, ...data }
        updates.push({ nodeId, data })
        return { node }
      },
    },
    agents: {
      launch: async (input: Record<string, unknown>) => {
        launches.push(input)
        return { node: { id: `agent-${++sequence}` } }
      },
    },
    preferences: {
      get: async () => ({ ...prefs }),
    },
  }

  return { host, ghCalls, launches, created, updates, nodes }
}
