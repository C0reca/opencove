import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import { registerSpaceHandlers } from '../../../src/app/main/controlSurface/handlers/spaceHandlers'
import { registerWorktreeHandlers } from '../../../src/app/main/controlSurface/handlers/worktreeHandlers'
import { registerNodeControlHandlers } from '../../../src/app/main/controlSurface/handlers/nodeControlHandlers'
import { resolveSpaceWorkingDirectoryFromStore } from '../../../src/app/main/controlSurface/handlers/resolveSpaceWorkingDirectoryFromStore'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import type { WorkerTopologyStore } from '../../../src/app/main/controlSurface/topology/topologyStore'
import type { PersistenceStore } from '../../../src/platform/persistence/sqlite/PersistenceStore'
import type { ApprovedWorkspaceStore } from '../../../src/contexts/workspace/infrastructure/approval/ApprovedWorkspaceStore'
import {
  normalizePersistedAppState,
  type NormalizedPersistedAppState,
} from '../../../src/platform/persistence/sqlite/normalize'
import type { ControlSurfaceInvokeResult } from '../../../src/shared/contracts/controlSurface/result'
import type {
  CreateChildSpaceResult,
  CreateNodeResult,
  CreateWorktreeResult,
} from '../../../src/shared/contracts/dto'

// Headless chain for #7: child Space -> worktree -> task + agent in that Space -> archive.
// Uses a real temporary git repo; the agent PTY launch is stubbed.

const ctx: ControlSurfaceContext = {
  now: () => new Date('2026-04-25T00:00:00.000Z'),
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd }).toString()

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'opencove-space-chain-')))
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'hi\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

function appState(
  repo: string,
  rootRect: { x: number; y: number; width: number; height: number } | null,
): unknown {
  return {
    formatVersion: 1,
    activeWorkspaceId: 'p1',
    workspaces: [
      {
        id: 'p1',
        name: 'Project',
        path: repo,
        worktreesRoot: '',
        pullRequestBaseBranchOptions: [],
        environmentVariables: {},
        spaceArchiveRecords: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        isMinimapVisible: true,
        spaces: [
          {
            id: 'root',
            name: 'Root',
            directoryPath: repo,
            targetMountId: null,
            labelColor: null,
            nodeIds: [],
            rect: rootRect,
          },
        ],
        activeSpaceId: 'root',
        nodes: [],
      },
    ],
    settings: {},
  }
}

function expectOk<T>(result: ControlSurfaceInvokeResult<unknown>): T {
  if (!result.ok) {
    throw new Error(`control surface call failed: ${result.error.code}`)
  }
  return result.value as T
}

function harness(initial: unknown) {
  const seed = normalizePersistedAppState(initial)
  if (!seed) {
    throw new Error('test fixture is not a valid app state')
  }
  let state: NormalizedPersistedAppState = seed
  let revision = 1

  // Only the methods the handlers under test call are implemented.
  const store = {
    readAppState: async () => state,
    readAppStateRevision: async () => revision,
    writeAppState: async (next: unknown) => {
      const normalized = normalizePersistedAppState(next)
      if (!normalized) {
        return {
          ok: false,
          error: { code: 'persistence.invalid_state', debugMessage: 'bad state' },
        }
      }
      state = normalized
      revision += 1
      return { ok: true, level: 'full', bytes: 1, revision }
    },
  } as unknown as PersistenceStore
  const getPersistenceStore = async () => store

  const launches: unknown[] = []
  const cs = createControlSurface()
  cs.register('session.launchAgent', {
    kind: 'command',
    validate: payload => payload,
    handle: async (_ctx, payload) => {
      launches.push(payload)
      return {
        sessionId: `s${launches.length}`,
        provider: 'codex' as const,
        startedAt: '2026-04-25T00:00:00.000Z',
        executionContext: { workingDirectory: '' },
        profileId: null,
        runtimeKind: 'posix' as const,
        resumeSessionId: null,
        effectiveModel: null,
      }
    },
    defaultErrorCode: 'agent.launch_failed',
  })
  registerSpaceHandlers(cs, getPersistenceStore)
  registerWorktreeHandlers(cs, {
    approvedWorkspaces: {
      registerRoot: async () => undefined,
      isPathApproved: async () => true,
    } as unknown as ApprovedWorkspaceStore,
    getPersistenceStore,
  })
  registerNodeControlHandlers(cs, {
    topology: {
      listEndpoints: async () => ({
        endpoints: [
          {
            endpointId: 'local',
            kind: 'local',
            displayName: 'Local',
            createdAt: '',
            updatedAt: '',
            remote: null,
          },
        ],
      }),
      listMounts: async () => ({ mounts: [] }),
    } as unknown as WorkerTopologyStore,
    getPersistenceStore,
  })

  const call = (
    kind: 'query' | 'command',
    id: string,
    payload: unknown,
  ): Promise<ControlSurfaceInvokeResult<unknown>> => cs.invoke(ctx, { kind, id, payload })

  return { call, state: () => state, launches, getPersistenceStore }
}

describe('space -> worktree -> task + agent chain (#7 headless)', () => {
  it('fails to create a child under a parent without a canvas rect', async () => {
    const h = harness(appState(makeRepo(), null))
    const r = await h.call('command', 'space.createChild', {
      parentSpaceId: 'root',
      name: 'issue-12-fix-foo',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.debugMessage).toContain('parent_missing_rect')
    }
  })

  it('binds a worktree to the child Space and launches the agent in it with its task link', async () => {
    const repo = makeRepo()
    const h = harness(appState(repo, { x: 0, y: 0, width: 1000, height: 800 }))

    const child = expectOk<CreateChildSpaceResult>(
      await h.call('command', 'space.createChild', {
        parentSpaceId: 'root',
        name: 'issue-12-fix-foo',
      }),
    )
    const childId = child.childSpace.id

    const wt = expectOk<CreateWorktreeResult>(
      await h.call('command', 'worktree.create', { spaceId: childId, name: 'issue-12-fix-foo' }),
    )
    const wtPath = wt.spaceDirectoryPath
    expect(wt.worktree.branch).toBe('issue-12-fix-foo')
    expect(git(repo, 'branch', '--list')).toContain('issue-12-fix-foo')

    const task = expectOk<CreateNodeResult>(
      await h.call('command', 'node.create', {
        kind: 'task',
        space: { kind: 'spaceId', spaceId: childId },
        data: { requirement: 'fix foo' },
      }),
    )
    const taskId = task.node.id

    const agent = expectOk<CreateNodeResult>(
      await h.call('command', 'node.create', {
        kind: 'agent',
        space: { kind: 'spaceId', spaceId: childId },
        data: { prompt: 'fix', provider: 'codex', taskNodeId: taskId, agentFullAccess: false },
      }),
    )
    expect(h.launches[0]).toMatchObject({ spaceId: childId, agentPermissionMode: 'default' })

    const session = await resolveSpaceWorkingDirectoryFromStore({
      spaceId: childId,
      getPersistenceStore: h.getPersistenceStore,
    })
    expect(session.workingDirectory).toBe(wtPath)

    const task2 = h.state().workspaces[0].nodes.find(node => node.id === taskId)
    expect(task2?.task).toMatchObject({
      status: 'doing',
      linkedAgentNodeId: agent.node.id,
    })
  })

  it('archive refuses dirty worktrees without force and removes them with force', async () => {
    const repo = makeRepo()
    const h = harness(appState(repo, { x: 0, y: 0, width: 1000, height: 800 }))
    const child = expectOk<CreateChildSpaceResult>(
      await h.call('command', 'space.createChild', {
        parentSpaceId: 'root',
        name: 'issue-12-fix-foo',
      }),
    )
    const childId = child.childSpace.id
    const wt = expectOk<CreateWorktreeResult>(
      await h.call('command', 'worktree.create', { spaceId: childId, name: 'issue-12-fix-foo' }),
    )
    const wtPath = wt.spaceDirectoryPath
    writeFileSync(join(wtPath, 'dirty.txt'), 'x')

    const refused = await h.call('command', 'worktree.archive', { spaceId: childId })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error.code).toBe('worktree.remove_uncommitted_changes')
    }

    const forced = await h.call('command', 'worktree.archive', {
      spaceId: childId,
      force: true,
      deleteBranch: true,
    })
    expect(forced.ok).toBe(true)
    expect(existsSync(wtPath)).toBe(false)
    expect(git(repo, 'branch', '--list')).not.toContain('issue-12-fix-foo')
    // The Space itself is kept; only its directory is reset.
    const space = h.state().workspaces[0].spaces.find(s => s.id === childId)
    expect(space?.directoryPath).toBe(repo)
  })
})
