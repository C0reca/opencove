import { afterEach, describe, expect, it, vi } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import { createNotifier, noticeFor } from '../../../plugins/github-issues/lib/notify.mjs'
import { createWakeService } from '../../../plugins/github-issues/lib/wake.mjs'
import { createFakeHost, failed, ok, remotes, type FakeNode } from './githubIssuesFakeHost'

const NTFY = { 'notify-channel': 'ntfy', 'ntfy-topic': 'cove-secret-topic' }

function fakeFetch(
  reply: () => Promise<{ ok: boolean; status: number }> | { ok: boolean; status: number },
) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl = vi.fn(async (url: URL, init: { body: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return reply()
  })
  return { calls, fetchImpl }
}

function notifierWith(prefs: Record<string, string>, reply = () => ({ ok: true, status: 200 })) {
  let clock = 0
  const { calls, fetchImpl } = fakeFetch(reply)
  const host = { preferences: { get: async () => prefs } }
  const notifier = createNotifier({ host, fetchImpl, now: () => clock })
  return { notifier, calls, at: (ms: number) => (clock = ms) }
}

const REVIEW = {
  key: 'review|C0reca/opencove#5',
  event: 'review',
  repo: 'C0reca/opencove',
  number: 5,
}

describe('github-issues notices', () => {
  it('sends nothing while the channel is off or the topic is empty', async () => {
    const cases = [{}, { 'notify-channel': 'off', 'ntfy-topic': 't' }, { 'notify-channel': 'ntfy' }]
    const results = await Promise.all(
      cases.map(async prefs => {
        const { notifier, calls } = notifierWith(prefs)
        return { sent: await notifier.notify(REVIEW), calls }
      }),
    )
    expect(results).toEqual(cases.map(() => ({ sent: false, calls: [] })))
  })

  it('publishes JSON to the server root with only the repository, number and event', async () => {
    const { notifier, calls } = notifierWith({ ...NTFY, 'ntfy-server': 'https://ntfy.example.org' })
    expect(await notifier.notify(REVIEW)).toBe(true)
    expect(calls).toEqual([
      {
        url: 'https://ntfy.example.org/',
        body: {
          topic: 'cove-secret-topic',
          title: 'C0reca/opencove#5',
          message: 'Pull request ready for review',
          tags: ['eyes'],
          click: 'https://github.com/C0reca/opencove/issues/5',
        },
      },
    ])
  })

  it('defaults to ntfy.sh', async () => {
    const { notifier, calls } = notifierWith(NTFY)
    await notifier.notify(REVIEW)
    expect(calls[0].url).toBe('https://ntfy.sh/')
  })

  it('sends one notice per key, and again after the window when one is given', async () => {
    const { notifier, calls, at } = notifierWith(NTFY)
    await notifier.notify(REVIEW)
    await notifier.notify(REVIEW)
    expect(calls).toHaveLength(1)

    await notifier.notify({ ...REVIEW, windowMs: 1_000 })
    at(999)
    await notifier.notify({ ...REVIEW, windowMs: 1_000 })
    expect(calls).toHaveLength(1)
    at(1_000)
    await notifier.notify({ ...REVIEW, windowMs: 1_000 })
    expect(calls).toHaveLength(2)
  })

  it('never throws when the send fails or the server refuses it', async () => {
    const thrown = notifierWith(NTFY, () => Promise.reject(new Error('offline')))
    await expect(thrown.notifier.notify(REVIEW)).resolves.toBe(false)
    const refused = notifierWith(NTFY, () => ({ ok: false, status: 500 }))
    await expect(refused.notifier.notify(REVIEW)).resolves.toBe(false)
    const badServer = notifierWith({ ...NTFY, 'ntfy-server': 'file:///etc/passwd' })
    await expect(badServer.notifier.notify(REVIEW)).resolves.toBe(false)
    expect(badServer.calls).toEqual([])
  })

  it('words each event without a number when there is none', () => {
    expect(noticeFor({ event: 'waiting', repo: 'o/r', number: 7, minutes: 10 }).message).toBe(
      'Agent waiting for over 10 min',
    )
    expect(noticeFor({ event: 'coordinator', repo: 'o/r' })).toMatchObject({
      title: 'o/r',
      url: 'https://github.com/o/r',
    })
  })
})

describe('github-issues notices from the wake service', () => {
  const coordinator: FakeNode = {
    id: 'coord',
    kind: 'agent',
    title: 'Issue coordinator',
    data: { kind: 'agent', prompt: '' },
  }
  const agent: FakeNode = {
    id: 'agent-43',
    kind: 'agent',
    title: '#43',
    data: { kind: 'agent', prompt: '' },
  }
  const task: FakeNode = {
    id: 'task-43',
    kind: 'task',
    title: '#43',
    data: {
      kind: 'task',
      tags: ['issue:C0reca/opencove#43'],
      linkedAgentNodeId: 'agent-43',
      status: 'doing',
    },
  }

  function wakeWith(agentStates: Record<string, { state: string; at: number }>) {
    const sessions: Record<string, string> = { coord: 'running' }
    const fake = createFakeHost({
      gh: () => failed('unused'),
      nodes: [coordinator, agent, task],
      agentStates,
      sessions,
      prefs: { 'notify-waiting-minutes': '10' },
    })
    let clock = 0
    const notify = vi.fn(async () => true)
    const wake = createWakeService({
      host: fake.host as never,
      projectIds: async () => ['p1'],
      now: () => clock,
      settleMs: 0,
      notifier: { notify },
    })
    return { wake, notify, sessions, at: (ms: number) => (clock = ms) }
  }

  it('notices an agent that has waited longer than the preference, once', async () => {
    const h = wakeWith({
      coord: { state: 'working', at: 0 },
      'agent-43': { state: 'waiting', at: 0 },
    })
    h.at(10 * 60_000 - 1)
    await h.wake.tick()
    expect(h.notify).not.toHaveBeenCalled()

    h.at(10 * 60_000)
    await h.wake.tick()
    await h.wake.tick()
    expect(h.notify).toHaveBeenCalledTimes(2)
    expect(h.notify).toHaveBeenCalledWith({
      key: `waiting|c0reca/opencove#43|${new Date(0).toISOString()}`,
      event: 'waiting',
      repo: 'c0reca/opencove',
      number: 43,
      minutes: 10,
    })
    // The same key twice: the notifier's dedupe turns that into one notice.
    expect(
      new Set(h.notify.mock.calls.map(call => (call as unknown as [{ key: string }])[0].key)).size,
    ).toBe(1)
  })

  it('notices a coordinator that stops while an issue task is in doing', async () => {
    const h = wakeWith({
      coord: { state: 'working', at: 0 },
      'agent-43': { state: 'working', at: 0 },
    })
    await h.wake.tick()
    expect(h.notify).not.toHaveBeenCalled()

    h.sessions.coord = 'exited'
    await h.wake.tick()
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'coordinator', repo: 'c0reca/opencove' }),
    )
    await h.wake.tick()
    expect(h.notify).toHaveBeenCalledTimes(1)
  })
})

describe('github-issues issue.request-review notice', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function gh(args: string[]) {
    const line = args.join(' ')
    if (line === 'remote -v') {
      return ok(remotes('C0reca/opencove'))
    }
    return line.startsWith('issue ') || line.startsWith('label ') ? ok('') : failed('unexpected')
  }

  it('still succeeds when the notice cannot be sent', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    vi.stubGlobal('fetch', fetchImpl)
    const fake = createFakeHost({ gh, prefs: NTFY })
    const plugin = await activate({ host: fake.host, log: () => undefined })
    const params = { projectId: 'p1', number: 5, summary: 'Done', evidence: 'Tests pass' }

    await expect(plugin.runCommand('issue.request-review', params, null)).resolves.toMatchObject({
      repo: 'C0reca/opencove',
      number: 5,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await plugin.dispose()
  })
})
