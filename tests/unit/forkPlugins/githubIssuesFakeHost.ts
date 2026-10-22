// Fake host for the github-issues backend. gh calls are answered by the test; canvas nodes,
// agent launches and preferences are kept in memory so tests can read back every side effect.

export type GhReply = { status?: string; exitCode?: number; output?: string; error?: string }

export interface FakeNode {
  id: string
  kind: string
  title: string
  spaceId?: string | null
  status?: string
  data: {
    kind: string
    tags?: string[]
    status?: string
    linkedAgentNodeId?: string | null
    requirement?: string
    prompt?: string
    taskId?: string | null
  }
}

export interface FakeHostOptions {
  gh: (args: string[], command?: string) => GhReply
  spaces?: Array<{ id: string; name: string }>
  launchError?: string
  prefs?: Record<string, string>
  nodes?: FakeNode[]
  agentStates?: Record<string, string>
  sessions?: Record<string, string>
  outputs?: Record<string, string>
  projects?: string[]
}

// The real host returns the Worker hub's latest observation event, not a bare string, and the
// hook channel reports a finished turn ('done') as 'standby' (#31). The fake mirrors that shape.
export const OBSERVED_AT_MS = Date.UTC(2026, 9, 22, 9, 49, 2)
function hubObservation(nodeId: string, state: string | undefined) {
  if (state === undefined) {
    return null
  }
  return {
    sessionId: `session-${nodeId}`,
    state: state === 'done' ? 'standby' : state,
    source: 'claude_hook',
    hookInstallState: 'installed',
    observedAtMs: OBSERVED_AT_MS,
  }
}

export const ok = (output: string): GhReply => ({ status: 'completed', exitCode: 0, output })

// `git remote -v` output for a GitHub origin.
export const remotes = (repo: string): string =>
  `origin\tgit@github.com:${repo}.git (fetch)\norigin\tgit@github.com:${repo}.git (push)\n`

export interface Launch {
  program: string
  args: string[]
  env: string[]
  repo: string | null
  reply?: GhReply
}

// Unwraps the plugin's `/usr/bin/env VAR=... <program> args` launcher. gh's `--repo X` suffix is
// recorded separately so tests keep matching the plain gh arguments; the login-shell lookup and
// `gh --version` probes answer as an installed gh.
export function unwrapLaunch(command: string, args: string[]): Launch {
  if (command !== '/usr/bin/env') {
    return { program: command, args, env: [], repo: null }
  }
  const start = args.findIndex(arg => !/^[A-Z_]+=/.test(arg))
  const env = args.slice(0, start)
  const program = args[start] ?? ''
  const rest = args.slice(start + 1)
  if (program === '/bin/sh' && rest[0] === '-c') {
    // The guard's info/exclude write: recorded by the fake host, never executed.
    return { program, args: rest, env, repo: null, reply: ok('') }
  }
  if (program === 'git' && rest[0] === 'rev-parse') {
    // The worktree's common git directory (outside the worktree, as in a linked worktree).
    return { program, args: rest, env, repo: null, reply: ok(`${COMMON_GIT_DIR}\n`) }
  }
  if (program === '/bin/sh') {
    // Login-shell lookup `command -v <tool>`: answers as installed under /opt/homebrew/bin.
    const tool = (rest[1] ?? '').split(' ').at(-1) ?? ''
    return { program, args: rest, env, repo: null, reply: ok(`/opt/homebrew/bin/${tool}\n`) }
  }
  const name = program.split('/').at(-1) ?? program
  if (name === 'gh') {
    if (rest[0] === '--version') {
      return { program: 'gh-probe', args: rest, env, repo: null, reply: ok('gh version 2') }
    }
    const at = rest.indexOf('--repo')
    const repo = at >= 0 ? (rest[at + 1] ?? null) : null
    const plain = at >= 0 ? [...rest.slice(0, at), ...rest.slice(at + 2)] : rest
    return { program: 'gh', args: plain, env, repo }
  }
  if (name === 'opencove') {
    return { program: 'opencove', args: rest, env, repo: null }
  }
  return { program, args: rest, env, repo: null }
}
export const failed = (error: string): GhReply => ({ status: 'completed', exitCode: 1, error })

export const COMMON_GIT_DIR = '/Users/me/repo/.git'
// The working directory the host resolves for a Space: a worktree path per Space id.
export const worktreeDirOf = (spaceId: string) => `/Users/me/.opencove/worktrees/${spaceId}`
export const PROJECT_DIR = '/Users/me/repo'

export function createFakeHost({
  gh,
  prefs = {},
  nodes: seeded = [],
  agentStates = {},
  sessions = {},
  outputs = {},
  projects = ['p1'],
  spaces = [],
  launchError,
}: FakeHostOptions) {
  const reads: string[] = []
  const processCalls: Array<{ command: string; args: string[] }> = []
  const ghCalls: string[][] = []
  const rawGhCalls: Launch[] = []
  const launches: Array<Record<string, unknown>> = []
  const created: FakeNode[] = []
  const updates: Array<{ nodeId: string; data: Record<string, unknown> }> = []
  // Files the plugin wrote through host.filesystem, keyed by `${spaceId ?? 'project'}:${path}`.
  const files = new Map<string, string>()
  const dirs: string[] = []
  // Shell scripts the plugin ran (the info/exclude append), recorded as argv.
  const shellCalls: string[][] = []
  const nodes = new Map<string, FakeNode>(seeded.map(node => [node.id, node]))
  const operations = new Map<string, GhReply>()
  let sequence = 0

  const host = {
    target: {
      list: async () => ({
        projects: projects.map(id => ({ id, name: id, spaces: id === 'p1' ? spaces : [] })),
      }),
      resolve: async ({ projectId, spaceId }: { projectId: string; spaceId?: string }) => ({
        projectId,
        spaceId: spaceId ?? null,
        workingDirectory: spaceId ? worktreeDirOf(spaceId) : PROJECT_DIR,
      }),
    },
    filesystem: {
      mkdir: async ({ target, path }: { target: { spaceId?: string }; path: string }) => {
        const key = `${target.spaceId ?? 'project'}:${path}`
        if (dirs.includes(key)) {
          throw new Error('already_exists')
        }
        dirs.push(key)
        return { target, uri: path }
      },
      writeText: async ({
        target,
        path,
        content,
      }: {
        target: { spaceId?: string }
        path: string
        content: string
      }) => {
        files.set(`${target.spaceId ?? 'project'}:${path}`, content)
        return { target, uri: path }
      },
    },
    operations: {
      start: async ({ command, args }: { command?: string; args: string[] }) => {
        const launch = unwrapLaunch(command ?? 'gh', args)
        let reply: GhReply
        if (launch.program === '/bin/sh' && launch.args[0] === '-c' && launch.reply) {
          shellCalls.push(launch.args)
          reply = launch.reply
        } else if (launch.program === 'opencove') {
          if (launch.args[0] !== '--help') {
            processCalls.push({ command: launch.program, args: launch.args })
          }
          reply = gh(launch.args, 'opencove')
        } else if (launch.program === 'gh') {
          rawGhCalls.push(launch)
          ghCalls.push(launch.args)
          reply = gh(launch.args, 'gh')
        } else {
          reply = launch.reply ?? gh(launch.args, launch.program)
        }
        const operationId = `op-${++sequence}`
        operations.set(operationId, reply)
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
      create: async ({
        kind,
        title,
        data,
        target,
      }: {
        kind: string
        title: string
        data: object
        target?: { spaceId?: string }
      }) => {
        const node: FakeNode = {
          id: `task-${++sequence}`,
          kind,
          title,
          spaceId: target?.spaceId ?? null,
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
      // Mirrors core #6: taskNodeId links both sides and moves the task to doing. The task must
      // exist, be a task, and be in the same Space as the launch target.
      launch: async (input: Record<string, unknown>) => {
        launches.push(input)
        if (launchError) {
          throw new Error(launchError)
        }
        const agentId = `agent-${++sequence}`
        const taskNodeId = input.taskNodeId as string | undefined
        if (taskNodeId !== undefined) {
          const task = nodes.get(taskNodeId)
          const target = input.target as { spaceId?: string }
          if (!task || task.kind !== 'task') {
            throw new Error(`no task ${taskNodeId}`)
          }
          if ((task.spaceId ?? undefined) !== (target.spaceId ?? undefined)) {
            throw new Error('task is in another Space')
          }
          task.data = { ...task.data, status: 'doing', linkedAgentNodeId: agentId }
        }
        return { node: { id: agentId } }
      },
      read: async ({ nodeId }: { nodeId: string }) => {
        reads.push(nodeId)
        return {
          nodeId,
          sessionId: `session-${nodeId}`,
          output: outputs[nodeId] ?? '',
          truncated: false,
          fromSeq: 0,
          toSeq: 0,
        }
      },
      get: async ({ nodeId }: { nodeId: string }) => {
        if (!nodes.has(nodeId)) {
          throw new Error(`no agent ${nodeId}`)
        }
        const status = sessions[nodeId]
        return {
          node: nodes.get(nodeId),
          session: status ? { status } : null,
          agentState: hubObservation(nodeId, agentStates[nodeId]),
        }
      },
    },
    preferences: {
      get: async () => ({ ...prefs }),
    },
  }

  return {
    host,
    ghCalls,
    rawGhCalls,
    processCalls,
    launches,
    created,
    updates,
    nodes,
    reads,
    files,
    dirs,
    shellCalls,
  }
}
