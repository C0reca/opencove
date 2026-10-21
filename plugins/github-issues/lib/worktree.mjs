// Worktree per issue: a child Space named for the issue, with a git worktree on a branch of the
// same name. Runs the `opencove` CLI on the project's machine through host.operations, with argv
// arrays only. The issue title is untrusted, so the name is reduced to [a-z0-9-] before use.
import { commandError } from './errors.mjs'
import { extractJson } from './gh.mjs'
import { runProcess } from './runGh.mjs'

export const SLUG_MAX_CHARS = 40
const CLI_TIMEOUT_MS = 60_000

// ASCII lowercase letters, digits and single hyphens, at most SLUG_MAX_CHARS, never ending in '-'.
export function slugify(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/, '')
}

// `issue-<N>-<slug>`, also used as the branch name. The number alone when the title has no ASCII.
export function issueSpaceName(number, title) {
  const slug = slugify(title)
  return slug ? `issue-${number}-${slug}` : `issue-${number}`
}

// Maps a failed opencove run to a coded error. The CLI prints its JSON error to stdout and a hint
// to stderr; both are searched.
export function classifyOpencoveFailure({ exitCode = null, output = '', error = '' } = {}) {
  const errorText = String(error ?? '')
  const combined = `${String(output ?? '')}\n${errorText}`

  if (/ENOENT|spawn opencove/i.test(errorText)) {
    return {
      code: 'cli-missing',
      message:
        'The opencove CLI is not on PATH on the project machine. Install it (Settings → Worker → CLI) and retry.',
    }
  }
  if (/parent_missing_rect/.test(combined)) {
    return {
      code: 'parent_missing_rect',
      message:
        'The root Space has no canvas position, so it cannot hold issue Spaces. Open the project on the canvas, place the root Space there, then retry.',
    }
  }
  if (/already exists|already checked out|branch.*exist/i.test(combined)) {
    return {
      code: 'branch-exists',
      message:
        'A branch or worktree with this issue name already exists. Remove it or rename it first.',
    }
  }
  const detail = combined
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0)
  return {
    code: 'cli-failed',
    message: (detail
      ? `opencove failed: ${detail}`
      : `opencove failed (exit ${exitCode ?? 'unknown'})`
    ).slice(0, 300),
  }
}

// Finds `childSpace.id` anywhere in the CLI result, so the wrapper's envelope does not matter.
export function findChildSpaceId(value) {
  if (!value || typeof value !== 'object') {
    return null
  }
  if (
    value.childSpace &&
    typeof value.childSpace.id === 'string' &&
    value.childSpace.id.length > 0
  ) {
    return value.childSpace.id
  }
  for (const nested of Object.values(value)) {
    const found = findChildSpaceId(nested)
    if (found) {
      return found
    }
  }
  return null
}

// Worktree Spaces live under .opencove/worktrees; they are never a root.
const WORKTREE_DIRECTORY = /[\\/]\.opencove[\\/]worktrees(?:[\\/]|$)/

export function isWorktreeDirectory(directoryPath) {
  return WORKTREE_DIRECTORY.test(String(directoryPath ?? ''))
}

// Finds the `spaces` array anywhere in the CLI result, so the wrapper's envelope does not matter.
export function findSpaceList(value) {
  if (!value || typeof value !== 'object') {
    return null
  }
  if (Array.isArray(value.spaces)) {
    return value.spaces
  }
  for (const nested of Object.values(value)) {
    const found = findSpaceList(nested)
    if (found) {
      return found
    }
  }
  return null
}

// Normalises the fields the root rule needs. Entries without an id are dropped.
export function normalizeSpaces(list) {
  return list
    .map(space => ({
      id: typeof space?.id === 'string' ? space.id : '',
      name: typeof space?.name === 'string' ? space.name : '',
      parentSpaceId: typeof space?.parentSpaceId === 'string' ? space.parentSpaceId : null,
      directoryPath: typeof space?.directoryPath === 'string' ? space.directoryPath : '',
      sortOrder: Number.isFinite(space?.sortOrder) ? space.sortOrder : 0,
    }))
    .filter(space => space.id.length > 0)
}

// Root rule: a Space with no parent that is not a worktree Space. Exactly one such Space is the
// root. None fails with no-root-space; several fail with ambiguous-root-space and list them, lowest
// sortOrder first. An explicit parentSpaceId wins, but it must be one of the project's Spaces.
export function selectRootSpace(spaces, { explicitParentSpaceId = null } = {}) {
  if (explicitParentSpaceId) {
    if (!spaces.some(space => space.id === explicitParentSpaceId)) {
      throw commandError(
        'parent-not-in-project',
        `Space ${explicitParentSpaceId} does not belong to this project.`,
        { parentSpaceId: explicitParentSpaceId },
      )
    }
    return explicitParentSpaceId
  }
  const candidates = spaces
    .filter(space => space.parentSpaceId === null && !isWorktreeDirectory(space.directoryPath))
    .sort((left, right) => left.sortOrder - right.sortOrder)
  if (candidates.length === 0) {
    throw commandError(
      'no-root-space',
      'The project has no root Space to hold issue worktrees. Create or place its root Space on the canvas, or pass parentSpaceId.',
    )
  }
  if (candidates.length > 1) {
    throw commandError(
      'ambiguous-root-space',
      'The project has more than one root Space. Pass parentSpaceId to choose one.',
      { candidates: candidates.map(space => ({ id: space.id, name: space.name })) },
    )
  }
  return candidates[0].id
}

// Lists the project's Spaces through the CLI, then applies the root rule.
export async function resolveRootSpace(host, projectId, { explicitParentSpaceId = null } = {}) {
  const listed = await runOpencove(host, projectId, ['space', 'list', '--project', projectId])
  if (!listed.ok) {
    throw commandError(listed.error.code, listed.error.message)
  }
  let list = null
  try {
    list = findSpaceList(extractJson(listed.output))
  } catch {
    list = null
  }
  if (!list) {
    throw commandError(
      'cli-unexpected-output',
      'opencove space list did not report the project Spaces.',
    )
  }
  return selectRootSpace(normalizeSpaces(list), { explicitParentSpaceId })
}

async function runOpencove(host, projectId, args) {
  const result = await runProcess(host, { projectId }, 'opencove', args, {
    timeoutMs: CLI_TIMEOUT_MS,
    classify: classifyOpencoveFailure,
    label: 'opencove',
  })
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  return { ok: true, output: result.output }
}

// Creates the child Space and its worktree. Returns { spaceId, branch }. When the worktree step
// fails, the thrown error carries the created Space so a person can clean it up. Nothing is deleted.
export async function createIssueWorktree({ host, projectId, rootSpaceId, name }) {
  const created = await runOpencove(host, projectId, [
    'space',
    'create',
    '--parent',
    rootSpaceId,
    '--name',
    name,
    '--project',
    projectId,
  ])
  if (!created.ok) {
    throw commandError(created.error.code, created.error.message, { name })
  }
  let spaceId = null
  try {
    spaceId = findChildSpaceId(extractJson(created.output))
  } catch {
    spaceId = null
  }
  if (!spaceId) {
    throw commandError(
      'cli-unexpected-output',
      'opencove space create did not report the new Space.',
      {
        name,
      },
    )
  }

  const worktree = await runOpencove(host, projectId, [
    'worktree',
    'create',
    '--space',
    spaceId,
    '--name',
    name,
  ])
  if (!worktree.ok) {
    throw commandError(worktree.error.code, worktree.error.message, {
      spaceId,
      branch: name,
      created: 'space',
    })
  }
  return { spaceId, branch: name }
}
