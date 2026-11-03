import { describe, expect, it } from 'vitest'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import { registerSpaceHandlers } from '../../../src/app/main/controlSurface/handlers/spaceHandlers'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import type { PersistenceStore } from '../../../src/platform/persistence/sqlite/PersistenceStore'

const ctx = { now: () => new Date('2026-11-02T00:00:00.000Z') } as ControlSurfaceContext

// oxlint-disable-next-line typescript-eslint/no-explicit-any -- loose fixture state
type State = { workspaces: Array<Record<string, any>> } & Record<string, unknown>

function createStore(initial: State) {
  let state = initial
  let revision = 0
  const store = {
    readAppState: async () => state,
    readAppStateRevision: async () => revision,
    writeAppState: async (next: State, options?: { expectedRevision?: number }) => {
      if (options?.expectedRevision !== undefined && options.expectedRevision !== revision) {
        return { ok: false, error: { code: 'persistence.conflict' } }
      }
      state = next
      revision += 1
      return { ok: true, level: 'full', bytes: 1 }
    },
  }
  return { store: store as unknown as PersistenceStore, read: () => state }
}

const node = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  title: id,
  position: { x: 0, y: 0 },
  width: 400,
  height: 300,
  ...extra,
})

const space = (
  id: string,
  parentSpaceId: string | null,
  nodeIds: string[],
  directoryPath = '/repo',
) => ({
  id,
  name: id,
  directoryPath,
  parentSpaceId,
  labelColor: null,
  nodeIds,
  rect: { x: 0, y: 0, width: 1000, height: 800 },
})

function appState(spaces: unknown[], nodes: unknown[]): State {
  return {
    formatVersion: 1,
    activeWorkspaceId: 'w1',
    workspaces: [
      {
        id: 'w1',
        name: 'Repo',
        path: '/repo',
        worktreesRoot: '/repo/.worktrees',
        viewport: { x: 0, y: 0, zoom: 1 },
        isMinimapVisible: true,
        activeSpaceId: 'issue',
        spaces,
        nodes,
        spaceArchiveRecords: [],
      },
    ],
  }
}

function setup(state: State, worktrees: string[] = []) {
  const { store, read } = createStore(state)
  const controlSurface = createControlSurface()
  const deleted: string[] = []
  // Stand-in for the real node.delete: removes the node and records the close.
  controlSurface.register('node.delete', {
    kind: 'command',
    validate: payload => payload as { nodeId: string },
    handle: async (_ctx, { nodeId }) => {
      deleted.push(nodeId)
      const current = read()
      const ws = current.workspaces[0]
      await store.writeAppState(
        {
          ...current,
          workspaces: [
            {
              ...ws,
              nodes: ws.nodes.filter((item: { id: string }) => item.id !== nodeId),
              spaces: ws.spaces.map((item: { nodeIds: string[] }) => ({
                ...item,
                nodeIds: item.nodeIds.filter(id => id !== nodeId),
              })),
            },
          ],
        },
        { expectedRevision: await store.readAppStateRevision() },
      )
      return { nodeId }
    },
    defaultErrorCode: 'common.unexpected',
  })
  registerSpaceHandlers(controlSurface, async () => store, {
    listWorktrees: async () => ({
      worktrees: worktrees.map(path => ({ path, head: null, branch: null })),
    }),
  })
  const archive = (spaceId: string) =>
    controlSurface.invoke(ctx, { kind: 'command', id: 'space.archive', payload: { spaceId } })
  return { archive, read, deleted }
}

describe('space.archive', () => {
  it('archives the Space subtree, closes live nodes through node.delete and keeps one record', async () => {
    const h = setup(
      appState(
        [
          space('root', null, ['keep']),
          space('issue', 'root', ['agent', 'task']),
          space('child', 'issue', ['note']),
        ],
        [
          node('keep', 'note', { task: { text: 'stays' } }),
          node('agent', 'agent', {
            sessionId: 'pty-1',
            status: 'standby',
            agent: { provider: 'claude-code', prompt: 'fix #43', executionDirectory: '/repo' },
          }),
          node('task', 'task', { task: { requirement: 'Fix #43', tags: ['issue:o/r#43'] } }),
          node('note', 'note', { task: { text: 'child note' } }),
        ],
      ),
    )

    const result = await h.archive('issue')

    expect(result).toMatchObject({
      ok: true,
      value: {
        projectId: 'w1',
        spaceId: 'issue',
        archivedSpaceIds: ['issue', 'child'],
        closedNodeIds: ['agent'],
      },
    })
    expect(h.deleted).toEqual(['agent'])
    const ws = h.read().workspaces[0]
    expect(ws.spaces.map((item: { id: string }) => item.id)).toEqual(['root'])
    expect(ws.nodes.map((item: { id: string }) => item.id)).toEqual(['keep'])
    expect(ws.activeSpaceId).toBeNull()
    expect(ws.spaceArchiveRecords).toHaveLength(1)
    const record = ws.spaceArchiveRecords[0]
    expect(record.space).toMatchObject({ id: 'issue', name: 'issue' })
    expect(record.spaces.map((item: { id: string }) => item.id)).toEqual(['issue', 'child'])
    expect(record.nodes).toEqual([
      expect.objectContaining({ kind: 'agent', id: 'agent', prompt: 'fix #43', status: 'standby' }),
      expect.objectContaining({
        kind: 'task',
        id: 'task',
        requirement: 'Fix #43',
        tags: ['issue:o/r#43'],
      }),
      expect.objectContaining({ kind: 'note', id: 'note', text: 'child note' }),
    ])
  })

  it('refuses a root Space', async () => {
    const h = setup(appState([space('root', null, [])], []))
    const result = await h.archive('root')
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'common.invalid_input', debugMessage: 'space.archive failed: root_space' },
    })
    expect(h.read().workspaces[0].spaces).toHaveLength(1)
  })

  it('refuses a Space whose subtree owns a git worktree, but not one that inherits it', async () => {
    const wt = '/repo/.worktrees/issue-43'
    const spaces = [
      space('root', null, []),
      space('issue', 'root', [], wt),
      space('child', 'issue', [], wt),
    ]
    const owner = setup(appState(spaces, []), [wt])
    expect(await owner.archive('issue')).toMatchObject({
      ok: false,
      error: { debugMessage: 'space.archive failed: space_has_worktree' },
    })
    expect(owner.read().workspaces[0].spaces).toHaveLength(3)

    const inherited = setup(appState(spaces, []), [wt])
    expect(await inherited.archive('child')).toMatchObject({ ok: true })
  })

  it('reports an unknown Space as space.not_found', async () => {
    const h = setup(appState([space('root', null, [])], []))
    expect(await h.archive('missing')).toMatchObject({
      ok: false,
      error: { code: 'space.not_found' },
    })
  })
})
