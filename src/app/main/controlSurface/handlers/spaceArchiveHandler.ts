import type { ControlSurface } from '../controlSurface'
import { createAppError } from '../../../../shared/errors/appError'
import type {
  ArchiveSpaceInput,
  ArchiveSpaceResult,
  GitWorktreeInfo,
} from '../../../../shared/contracts/dto'
import type { PersistenceStore } from '../../../../platform/persistence/sqlite/PersistenceStore'
import {
  normalizePersistedAppState,
  type NormalizedPersistedNode,
} from '../../../../platform/persistence/sqlite/normalize'
import { collectSpaceSubtree } from '../../../../contexts/space/application/spaceTree'
import { resolveSpaceOwnWorktree } from '../../../../contexts/space/application/spaceWorktreeEligibility'
import { computeSpaceDirectoryUpdate } from '../../../../contexts/space/application/updateSpaceDirectory'
import { listGitWorktrees } from '../../../../contexts/worktree/infrastructure/git/GitWorktreeService'
import {
  appendSpaceArchiveRecord,
  buildSpaceArchiveRecord,
  type SpaceArchiveNodeSource,
} from '../../../../shared/utils/spaceArchiveRecord'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function normalizeArchivePayload(payload: unknown): ArchiveSpaceInput {
  if (!isRecord(payload) || typeof payload.spaceId !== 'string' || !payload.spaceId.trim()) {
    throw createAppError('common.invalid_input', {
      debugMessage: 'Invalid payload for space.archive spaceId.',
    })
  }
  const projectId = payload.projectId
  if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') {
    throw createAppError('common.invalid_input', {
      debugMessage: 'Invalid payload for space.archive projectId.',
    })
  }
  return {
    spaceId: payload.spaceId.trim(),
    projectId: typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null,
  }
}

// Persisted nodes keep note and plugin payloads in `task`; the archive builder reads them by kind.
function toArchiveNodeSource(node: NormalizedPersistedNode): SpaceArchiveNodeSource {
  const payload = node.task
  return {
    ...node,
    agent: node.kind === 'agent' ? node.agent : null,
    task: node.kind === 'task' ? payload : null,
    note: node.kind === 'note' ? payload : null,
    plugin: node.kind === 'plugin' ? payload : null,
  } as SpaceArchiveNodeSource
}

// Nodes with a live runtime (a PTY session, a website view, a plugin view) are closed through
// node.delete, the same path the canvas uses, before the Space leaves the state.
function needsRuntimeClose(node: NormalizedPersistedNode): boolean {
  return Boolean(node.sessionId) || node.kind === 'website' || node.kind === 'plugin'
}

function findArchiveTarget(
  normalized: NonNullable<ReturnType<typeof normalizePersistedAppState>>,
  input: ArchiveSpaceInput,
) {
  const workspace =
    normalized.workspaces.find(item =>
      input.projectId
        ? item.id === input.projectId
        : item.spaces.some(space => space.id === input.spaceId),
    ) ?? null
  const space = workspace?.spaces.find(candidate => candidate.id === input.spaceId) ?? null
  if (!workspace || !space) {
    throw createAppError('space.not_found', {
      debugMessage: `space.archive: unknown space id: ${input.spaceId}`,
    })
  }
  return { workspace, space }
}

export function registerSpaceArchiveHandler(
  controlSurface: ControlSurface,
  getPersistenceStore: () => Promise<PersistenceStore>,
  deps: {
    listWorktrees?: (input: { repoPath: string }) => Promise<{ worktrees: GitWorktreeInfo[] }>
  },
): void {
  // Same semantics as the canvas "Archive Space" action without worktree cleanup: the Space and its
  // subtree leave the canvas, their live nodes are closed and one archive record is kept. A Space
  // with its own worktree is refused; `worktree.archive` first returns it to the project root.
  controlSurface.register('space.archive', {
    kind: 'command',
    validate: normalizeArchivePayload,
    handle: async (ctx, payload): Promise<ArchiveSpaceResult> => {
      const store = await getPersistenceStore()
      const before = normalizePersistedAppState(await store.readAppState())
      if (!before) {
        throw createAppError('common.invalid_input', {
          debugMessage: 'space.archive requires an app state.',
        })
      }

      const { workspace, space } = findArchiveTarget(before, payload)
      if (!space.parentSpaceId) {
        throw createAppError('common.invalid_input', {
          debugMessage: 'space.archive failed: root_space',
        })
      }

      const scope = collectSpaceSubtree(workspace.spaces, space.id)
      // Only ask git when a Space in scope has a directory of its own (not the root, not inherited).
      const ownDirectory = (worktrees: GitWorktreeInfo[]) =>
        scope.some(candidate =>
          resolveSpaceOwnWorktree({
            space: candidate,
            spaces: workspace.spaces,
            worktrees,
            repoRootPath: workspace.path,
          }),
        )
      const candidates = scope.map(candidate => ({
        path: candidate.directoryPath,
        head: null,
        branch: null,
      }))
      if (ownDirectory(candidates)) {
        const listed = await (deps.listWorktrees ?? listGitWorktrees)({ repoPath: workspace.path })
        if (ownDirectory(listed.worktrees)) {
          throw createAppError('common.invalid_input', {
            debugMessage: 'space.archive failed: space_has_worktree',
          })
        }
      }

      const record = buildSpaceArchiveRecord({
        space,
        spaces: scope,
        nodes: workspace.nodes.map(toArchiveNodeSource),
      })

      const scopedNodeIds = new Set(scope.flatMap(candidate => candidate.nodeIds))
      const closedNodeIds = workspace.nodes
        .filter(node => scopedNodeIds.has(node.id) && needsRuntimeClose(node))
        .map(node => node.id)
      /* eslint-disable no-await-in-loop -- node.delete writes the state; parallel calls would conflict on the revision */
      for (const nodeId of closedNodeIds) {
        const closed = await controlSurface.invoke(ctx, {
          kind: 'command',
          id: 'node.delete',
          payload: { nodeId },
        })
        if (!closed.ok && closed.error.code !== 'node.not_found') {
          throw createAppError(closed.error)
        }
      }
      /* eslint-enable no-await-in-loop */

      // Re-read: node.delete wrote the state in between.
      const expectedRevision = await store.readAppStateRevision()
      const normalized = normalizePersistedAppState(await store.readAppState())
      const current = normalized ? findArchiveTarget(normalized, payload).workspace : null
      const update = current
        ? computeSpaceDirectoryUpdate({
            workspacePath: current.path,
            spaces: current.spaces,
            spaceId: space.id,
            directoryPath: current.path,
            options: { archiveSpace: true },
          })
        : null
      if (!normalized || !current || !update) {
        throw createAppError('space.not_found', {
          debugMessage: `space.archive: space disappeared while archiving: ${space.id}`,
        })
      }

      const archivedSpaceIds = current.spaces
        .filter(candidate => !update.nextSpaces.includes(candidate))
        .map(candidate => candidate.id)
      const nextState = {
        ...normalized,
        workspaces: normalized.workspaces.map(candidate =>
          candidate.id === current.id
            ? {
                ...candidate,
                spaces: update.nextSpaces,
                nodes: candidate.nodes.filter(node => !update.targetNodeIds.has(node.id)),
                activeSpaceId: archivedSpaceIds.includes(candidate.activeSpaceId ?? '')
                  ? null
                  : candidate.activeSpaceId,
                spaceArchiveRecords: appendSpaceArchiveRecord(
                  candidate.spaceArchiveRecords,
                  record,
                ),
              }
            : candidate,
        ),
      }

      const writeResult = await store.writeAppState(nextState, { expectedRevision })
      if (!writeResult.ok) {
        throw createAppError(writeResult.error)
      }

      return {
        projectId: current.id,
        spaceId: space.id,
        archivedSpaceIds,
        archivedNodeIds: [...scopedNodeIds],
        closedNodeIds,
        recordId: record.id,
      }
    },
    defaultErrorCode: 'common.unexpected',
  })
}
