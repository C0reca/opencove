import { describe, expect, it } from 'vitest'
import { toShellWorkspaceStateForSync } from '../../../src/app/renderer/shell/hooks/workerSync/mergeWorkspaceStateForSync'
import type { PersistedWorkspaceState } from '../../../src/contexts/workspace/presentation/renderer/types'

const space = (id: string, parentSpaceId: string | null, nodeIds: string[]) => ({
  id,
  name: id,
  directoryPath: '/repo',
  targetMountId: null,
  parentSpaceId,
  boundary: null,
  labelColor: null,
  nodeIds,
  rect: { x: 0, y: 0, width: 800, height: 600 },
})

const base = {
  id: 'workspace-1',
  name: 'Workspace',
  path: '/repo',
  worktreesRoot: '',
  pullRequestBaseBranchOptions: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  isMinimapVisible: true,
  activeSpaceId: null,
}

const note = {
  id: 'note-1',
  title: 'note',
  position: { x: 0, y: 0 },
  width: 300,
  height: 200,
  kind: 'note',
  status: null,
  startedAt: null,
  endedAt: null,
  exitCode: null,
  lastError: null,
  task: { text: 'issue note' },
}

describe('worker sync after space.archive in the main process', () => {
  it('drops the archived Space and its nodes and adopts the new archive record', () => {
    const before = {
      ...base,
      spaces: [space('root', null, []), space('issue', 'root', ['note-1'])],
      spaceArchiveRecords: [],
      nodes: [note],
    } as unknown as PersistedWorkspaceState
    const existing = toShellWorkspaceStateForSync(before, undefined)
    expect(existing.spaces.map(item => item.id)).toEqual(['root', 'issue'])

    const record = {
      id: 'record-1',
      archivedAt: '2026-11-02T00:00:00.000Z',
      git: null,
      space: { id: 'issue', name: 'issue', directoryPath: '/repo', labelColor: null, rect: null },
      spaces: [space('issue', 'root', ['note-1'])],
      nodes: [{ kind: 'note', id: 'note-1', title: 'note', frame: null, text: 'issue note' }],
    }
    const after = {
      ...base,
      spaces: [space('root', null, [])],
      spaceArchiveRecords: [record],
      nodes: [],
    } as unknown as PersistedWorkspaceState

    const merged = toShellWorkspaceStateForSync(after, existing)

    expect(merged.spaces.map(item => item.id)).toEqual(['root'])
    expect(merged.nodes).toEqual([])
    expect(merged.spaceArchiveRecords.map(item => item.id)).toEqual(['record-1'])
  })
})
