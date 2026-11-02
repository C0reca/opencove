import { invokeControlSurface } from '../invoke.mjs'
import { readFlagValue, requireFlagValue } from '../args.mjs'

function fail(message) {
  process.stderr.write(`[opencove] ${message}\n`)
  process.exit(2)
}

async function createChildSpace({ connection, args, pretty, timeoutMs }) {
  const parentSpaceId = requireFlagValue(args, '--parent')
  const name = readFlagValue(args, '--name')
  const projectId = readFlagValue(args, '--project')
  const payload = {
    parentSpaceId,
    ...(name ? { name } : {}),
    ...(projectId ? { projectId } : {}),
  }

  const { result } = await invokeControlSurface(
    connection,
    { kind: 'command', id: 'space.createChild', payload },
    { timeoutMs },
  )
  process.stdout.write(`${pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)}\n`)

  if (!result || result.ok === false) {
    const debugMessage = result?.error?.debugMessage ?? ''
    if (debugMessage.includes('parent_missing_rect')) {
      process.stderr.write(
        `[opencove] space ${parentSpaceId} has no canvas position yet, so it cannot hold a child space. Open the project on the canvas, select or move the space there, then retry.\n`,
      )
    }
    process.exit(1)
  }
}

const ARCHIVE_HINTS = {
  root_space: 'is a root Space. Only Spaces inside another Space can be archived from the CLI.',
  space_has_worktree:
    'or a Space inside it has its own git worktree. Run `opencove worktree archive --space <id>` for that Space first, then retry.',
}

async function archiveSpace({ connection, args, pretty, timeoutMs }) {
  const spaceId = requireFlagValue(args, '--space')
  const projectId = readFlagValue(args, '--project')
  const { result } = await invokeControlSurface(
    connection,
    {
      kind: 'command',
      id: 'space.archive',
      payload: { spaceId, ...(projectId ? { projectId } : {}) },
    },
    { timeoutMs },
  )
  process.stdout.write(`${pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)}\n`)

  if (!result || result.ok === false) {
    const debugMessage = result?.error?.debugMessage ?? ''
    const hint = Object.entries(ARCHIVE_HINTS).find(([code]) => debugMessage.endsWith(code))
    if (hint) {
      process.stderr.write(`[opencove] space ${spaceId} ${hint[1]}\n`)
    }
    process.exit(1)
  }
}

export async function tryHandleSpaceCommands({ command, args, connection, pretty, timeoutMs }) {
  if (command === 'space' && args[1] === 'create') {
    if (!readFlagValue(args, '--parent')) {
      fail('missing required flag: --parent <spaceId>')
    }
    await createChildSpace({ connection, args, pretty, timeoutMs })
    return true
  }

  if (command === 'space' && args[1] === 'archive') {
    if (!readFlagValue(args, '--space')) {
      fail('missing required flag: --space <spaceId>')
    }
    await archiveSpace({ connection, args, pretty, timeoutMs })
    return true
  }

  return false
}
