import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWakeService, wakeMessage } from '../../../plugins/github-issues/lib/wake.mjs'
import { createFakeHost, failed, type FakeNode } from './githubIssuesFakeHost'

const COORD = 'coord'
const WAITING_43 =
  '[github-issues] #43 agent is now waiting. Read it with agents.read and tell the human what it asks.'
const DONE_43 = '[github-issues] #43 agent is done. Run your next loop.'
const DONE_44 = '[github-issues] #44 agent is done. Run your next loop.'
const MIXED =
  '[github-issues] #43 agent is now waiting; #44 agent is done. Read it with agents.read and tell the human what it asks. Run your next loop.'

type Observation = string | { state: string; at: number }

const coordinator = (): FakeNode => ({
  id: COORD,
  kind: 'agent',
  title: 'Issue coordinator',
  data: { kind: 'agent', prompt: '' },
})

const issueAgent = (n: number): FakeNode => ({
  id: `agent-${n}`,
  kind: 'agent',
  title: `#${n}`,
  data: { kind: 'agent', prompt: '' },
})

const issueTask = (n: number): FakeNode => ({
  id: `task-${n}`,
  kind: 'task',
  title: `#${n}`,
  data: {
    kind: 'task',
    tags: [`issue:C0reca/opencove#${n}`],
    linkedAgentNodeId: `agent-${n}`,
    status: 'doing',
  },
})

// One project (p1) with issue agents 43 and 44, and optionally a running coordinator.
function harness(
  options: {
    coordState?: Observation
    coordRunning?: boolean
    withCoordinator?: boolean
    agents?: Record<string, Observation>
    prefs?: Record<string, unknown>
    settleMs?: number
    submitDelayMs?: number
    holdMs?: number
    failTextWrites?: number
    sleep?: (ms: number) => Promise<void>
  } = {},
) {
  const withCoordinator = options.withCoordinator ?? true
  const agentStates: Record<string, Observation> = { ...(options.agents ?? {}) }
  if (options.coordState !== undefined) {
    agentStates[COORD] = options.coordState
  }
  const sessions: Record<string, string> = {
    [COORD]: options.coordRunning === false ? 'stopped' : 'running',
  }
  const nodes = [issueAgent(43), issueAgent(44), issueTask(43), issueTask(44)]
  if (withCoordinator) {
    nodes.unshift(coordinator())
  }
  const fake = createFakeHost({
    gh: () => failed('unused'),
    nodes,
    agentStates,
    sessions,
    prefs: options.prefs ?? {},
  })

  // Fails the first N text writes (writes without a carriage return), to test the queue.
  let failures = options.failTextWrites ?? 0
  const host = {
    ...fake.host,
    agents: {
      ...fake.host.agents,
      write: async (input: { nodeId: string; data: string }) => {
        if (failures > 0 && !input.data.includes('\r')) {
          failures -= 1
          throw new Error('terminal busy')
        }
        return fake.host.agents.write(input)
      },
    },
  }

  let clock = 0
  const sleeps: number[] = []
  const wake = createWakeService({
    host: host as never,
    projectIds: async () => ['p1'],
    log: () => undefined,
    now: () => clock,
    sleep:
      options.sleep ??
      (async ms => {
        sleeps.push(ms)
      }),
    settleMs: options.settleMs ?? 0,
    submitDelayMs: options.submitDelayMs ?? 1500,
    holdMs: options.holdMs ?? 120_000,
  })

  return {
    wake,
    host,
    agentStates,
    sleeps,
    writes: fake.writes,
    at: (ms: number) => {
      clock = ms
    },
  }
}

describe('github-issues wake message', () => {
  it('names each issue and its state, in one line, with the plain trigger prefix', () => {
    expect(wakeMessage([{ label: '#43', state: 'waiting' }])).toBe(WAITING_43)
    expect(wakeMessage([{ label: '#43', state: 'done' }])).toBe(DONE_43)
    expect(
      wakeMessage([
        { label: '#43', state: 'waiting' },
        { label: '#44', state: 'done' },
      ]),
    ).toBe(MIXED)
  })
})

describe('github-issues wake transitions', () => {
  it('wakes the coordinator once when an issue agent starts waiting', async () => {
    const h = harness({ coordState: 'done', agents: { 'agent-43': { state: 'working', at: 1 } } })
    await h.wake.tick()
    expect(h.writes).toEqual([])

    h.agentStates['agent-43'] = { state: 'waiting', at: 2 }
    await h.wake.tick()
    expect(h.writes).toEqual([
      { nodeId: COORD, data: WAITING_43 },
      { nodeId: COORD, data: '\r' },
    ])

    await h.wake.tick()
    expect(h.writes).toHaveLength(2)
  })

  it('wakes the coordinator with the done message when an issue agent finishes', async () => {
    const h = harness({ coordState: 'done', agents: { 'agent-43': { state: 'working', at: 1 } } })
    await h.wake.tick()
    h.agentStates['agent-43'] = { state: 'done', at: 2 }
    await h.wake.tick()
    expect(h.writes[0]).toEqual({ nodeId: COORD, data: DONE_43 })
  })

  it('does not repeat a transition for the same observation, but reports a new one', async () => {
    const h = harness({ coordState: 'done', agents: { 'agent-43': { state: 'working', at: 1 } } })
    await h.wake.tick()
    h.agentStates['agent-43'] = { state: 'waiting', at: 2 }
    await h.wake.tick()
    await h.wake.tick()
    await h.wake.tick()
    expect(h.writes).toHaveLength(2)

    h.agentStates['agent-43'] = { state: 'working', at: 3 }
    await h.wake.tick()
    expect(h.writes).toHaveLength(2)

    // The coordinator reacts to the first wake (a new observation) before the next transition.
    h.agentStates[COORD] = { state: 'done', at: 5 }
    h.agentStates['agent-43'] = { state: 'waiting', at: 4 }
    await h.wake.tick()
    expect(h.writes).toHaveLength(4)
  })

  it('does not treat an agent that is already waiting at the first look as a transition', async () => {
    const h = harness({ coordState: 'done', agents: { 'agent-43': { state: 'waiting', at: 1 } } })
    await h.wake.tick()
    await h.wake.tick()
    expect(h.writes).toEqual([])
  })
})

describe('github-issues wake coalescing', () => {
  it('sends one message for transitions that settle together', async () => {
    const h = harness({
      coordState: 'done',
      settleMs: 5000,
      agents: { 'agent-43': { state: 'working', at: 1 }, 'agent-44': { state: 'working', at: 1 } },
    })
    h.at(0)
    await h.wake.tick()

    h.agentStates['agent-43'] = { state: 'waiting', at: 2 }
    h.agentStates['agent-44'] = { state: 'done', at: 2 }
    h.at(1000)
    await h.wake.tick()
    h.at(3000)
    await h.wake.tick()
    expect(h.writes).toEqual([])

    h.at(6000)
    await h.wake.tick()
    expect(h.writes).toEqual([
      { nodeId: COORD, data: MIXED },
      { nodeId: COORD, data: '\r' },
    ])
  })
})

describe('github-issues wake coordinator state', () => {
  it('never writes while the coordinator is working, then flushes once it is waiting', async () => {
    const h = harness({
      coordState: 'working',
      agents: { 'agent-43': { state: 'working', at: 1 } },
    })
    await h.wake.tick()
    h.agentStates['agent-43'] = { state: 'waiting', at: 2 }
    await h.wake.tick()
    await h.wake.tick()
    expect(h.writes).toEqual([])

    h.agentStates[COORD] = { state: 'waiting', at: 9 }
    await h.wake.tick()
    expect(h.writes).toEqual([
      { nodeId: COORD, data: WAITING_43 },
      { nodeId: COORD, data: '\r' },
    ])
  })

  it('queues the message while the coordinator has no observed state', async () => {
    const h = harness({ agents: { 'agent-43': { state: 'working', at: 1 } } })
    await h.wake.tick()
    h.agentStates['agent-43'] = { state: 'done', at: 2 }
    await h.wake.tick()
    expect(h.writes).toEqual([])
  })

  it('waits for the coordinator to react before waking it again', async () => {
    const h = harness({
      coordState: 'done',
      holdMs: 120_000,
      agents: { 'agent-43': { state: 'working', at: 1 } },
    })
    h.at(0)
    await h.wake.tick()
    h.agentStates['agent-43'] = { state: 'waiting', at: 2 }
    h.at(1000)
    await h.wake.tick()
    expect(h.writes).toHaveLength(2)

    // A second transition arrives while the coordinator still shows its pre-wake observation.
    h.agentStates['agent-44'] = { state: 'done', at: 3 }
    h.at(2000)
    await h.wake.tick()
    expect(h.writes).toHaveLength(2)

    // The coordinator reacts (a new observation) and is waiting again: the queued wake goes out.
    h.agentStates[COORD] = { state: 'waiting', at: 50 }
    h.at(3000)
    await h.wake.tick()
    expect(h.writes).toHaveLength(4)
    expect(h.writes[2]).toEqual({ nodeId: COORD, data: DONE_44 })
  })
})

describe('github-issues wake submission', () => {
  it('sends the text and the Enter key as two writes with a pause between them', async () => {
    const h = harness({
      coordState: 'done',
      submitDelayMs: 1500,
      agents: { 'agent-43': { state: 'working', at: 1 } },
    })
    await h.wake.tick()
    h.agentStates['agent-43'] = { state: 'waiting', at: 2 }
    await h.wake.tick()

    expect(h.writes.map(write => write.data)).toEqual([WAITING_43, '\r'])
    expect(h.writes[0].data).not.toContain('\r')
    expect(h.sleeps).toEqual([1500])
  })

  it('keeps the message queued when the text write fails, and sends no Enter for it', async () => {
    const h = harness({
      coordState: 'done',
      failTextWrites: 1,
      agents: { 'agent-43': { state: 'working', at: 1 } },
    })
    await h.wake.tick()
    h.agentStates['agent-43'] = { state: 'waiting', at: 2 }
    await h.wake.tick()
    expect(h.writes).toEqual([])

    await h.wake.tick()
    expect(h.writes.map(write => write.data)).toEqual([WAITING_43, '\r'])
  })
})

describe('github-issues wake without a coordinator or with the preference off', () => {
  it('does nothing when no coordinator is running in the project', async () => {
    const h = harness({
      withCoordinator: false,
      agents: { 'agent-43': { state: 'working', at: 1 } },
    })
    await h.wake.tick()
    h.agentStates['agent-43'] = { state: 'waiting', at: 2 }
    await h.wake.tick()
    expect(h.writes).toEqual([])
  })

  it('does nothing when the only coordinator has a stopped session', async () => {
    const h = harness({
      coordState: 'done',
      coordRunning: false,
      agents: { 'agent-43': { state: 'working', at: 1 } },
    })
    await h.wake.tick()
    h.agentStates['agent-43'] = { state: 'waiting', at: 2 }
    await h.wake.tick()
    expect(h.writes).toEqual([])
  })

  it('takes a silent baseline when a coordinator starts, so older states are not replayed', async () => {
    const h = harness({ coordState: 'done', agents: { 'agent-43': { state: 'waiting', at: 1 } } })
    await h.wake.tick()
    expect(h.writes).toEqual([])
    h.agentStates['agent-44'] = { state: 'done', at: 5 }
    await h.wake.tick()
    expect(h.writes[0]).toEqual({ nodeId: COORD, data: DONE_44 })
  })

  it('writes nothing while the coordinator-wake preference is false', async () => {
    const h = harness({
      coordState: 'done',
      prefs: { 'coordinator-wake': false },
      agents: { 'agent-43': { state: 'working', at: 1 } },
    })
    await h.wake.tick()
    h.agentStates['agent-43'] = { state: 'waiting', at: 2 }
    await h.wake.tick()
    expect(h.writes).toEqual([])
  })

  it('is on when the preference is not set', async () => {
    const h = harness({ coordState: 'done', agents: { 'agent-43': { state: 'working', at: 1 } } })
    await h.wake.tick()
    h.agentStates['agent-43'] = { state: 'waiting', at: 2 }
    await h.wake.tick()
    expect(h.writes).toHaveLength(2)
  })
})

describe('github-issues wake lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs on a bounded timer and stops touching the host after dispose', async () => {
    vi.useFakeTimers()
    const h = harness({ coordState: 'done' })
    const list = vi.spyOn(h.host.nodes, 'list')

    h.wake.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(list).toHaveBeenCalled()

    await h.wake.dispose()
    list.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(list).not.toHaveBeenCalled()
  })

  it('waits for an in-flight pass before dispose resolves', async () => {
    let release: () => void = () => undefined
    const h = harness({
      coordState: 'done',
      sleep: () => new Promise<void>(resolve => (release = resolve)),
      agents: { 'agent-43': { state: 'working', at: 1 } },
    })
    await h.wake.tick()
    h.agentStates['agent-43'] = { state: 'waiting', at: 2 }
    const pass = h.wake.tick()
    await vi.waitFor(() => expect(h.writes).toHaveLength(1))

    let disposed = false
    const closing = h.wake.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await pass
    await closing
    expect(disposed).toBe(true)
  })
})
