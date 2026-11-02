import { describe, expect, it } from 'vitest'
import {
  appendSpaceArchiveRecord,
  buildSpaceArchiveRecord,
  MAX_SPACE_ARCHIVE_RECORDS,
} from '../../../src/shared/utils/spaceArchiveRecord'

const space = {
  id: 's1',
  name: 'Issue 43',
  directoryPath: '/repo',
  targetMountId: null,
  parentSpaceId: 'root',
  boundary: null,
  labelColor: null,
  nodeIds: ['p1', 'gone', 'img'],
  rect: null,
}

describe('shared space archive record', () => {
  it('snapshots flat node sources and skips unknown or missing nodes', () => {
    const record = buildSpaceArchiveRecord({
      space,
      recordId: 'r1',
      archivedAt: '2026-11-02T00:00:00.000Z',
      nodes: [
        {
          id: 'p1',
          kind: 'plugin',
          title: 'Review queue',
          position: { x: 1, y: 2 },
          width: 300,
          height: 200,
          plugin: { pluginId: 'github-issues', repoPath: '/repo' },
        },
        { id: 'img', kind: 'image', title: 'img', position: { x: 0, y: 0 }, width: 1, height: 1 },
      ],
    })

    expect(record.nodes).toEqual([
      {
        kind: 'plugin',
        id: 'p1',
        title: 'Review queue',
        frame: { position: { x: 1, y: 2 }, size: { width: 300, height: 200 } },
        labelColorOverride: null,
        pluginId: 'github-issues',
        schemaVersion: 1,
        repoPath: '/repo',
        mountId: null,
      },
    ])
    expect(record.spaces?.map(item => item.id)).toEqual(['s1'])
  })

  it('keeps the newest records first, up to the limit', () => {
    const many = Array.from({ length: MAX_SPACE_ARCHIVE_RECORDS }, (_, index) => index)
    const next = appendSpaceArchiveRecord(many, -1)
    expect(next).toHaveLength(MAX_SPACE_ARCHIVE_RECORDS)
    expect(next[0]).toBe(-1)
  })
})
