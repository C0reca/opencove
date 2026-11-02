import type { Node } from '@xyflow/react'
import {
  appendSpaceArchiveRecord as appendRecord,
  buildSpaceArchiveRecord as buildRecord,
  type SpaceArchiveNodeSource,
} from '@shared/utils/spaceArchiveRecord'
import type {
  TerminalNodeData,
  SpaceArchiveRecord,
  SpaceArchiveSpaceSnapshot,
  WorkspaceSpaceState,
} from '../types'

// The record itself is built in src/shared, so the Control Surface's space.archive writes the same
// record. This adapter only flattens the canvas nodes.
export function buildSpaceArchiveRecord(
  input: Omit<Parameters<typeof buildRecord>[0], 'nodes' | 'space' | 'spaces'> & {
    space: WorkspaceSpaceState
    spaces?: WorkspaceSpaceState[]
    nodes: Node<TerminalNodeData>[]
  },
): SpaceArchiveRecord {
  return buildRecord({
    ...input,
    nodes: input.nodes.map(
      (node): SpaceArchiveNodeSource => ({ ...node.data, id: node.id, position: node.position }),
    ),
  })
}

export function getSpaceArchiveRecordSpaces(
  record: SpaceArchiveRecord,
): SpaceArchiveSpaceSnapshot[] {
  if (Array.isArray(record.spaces) && record.spaces.length > 0) {
    return record.spaces
  }

  return [
    {
      id: record.space.id,
      name: record.space.name,
      directoryPath: record.space.directoryPath,
      targetMountId: null,
      parentSpaceId: null,
      boundary: null,
      labelColor: record.space.labelColor,
      nodeIds: record.nodes.map(node => node.id),
      rect: record.space.rect,
    },
  ]
}

export function appendSpaceArchiveRecord(
  previous: SpaceArchiveRecord[],
  next: SpaceArchiveRecord,
): SpaceArchiveRecord[] {
  return appendRecord(previous, next)
}
