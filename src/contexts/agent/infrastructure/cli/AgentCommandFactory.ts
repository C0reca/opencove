import type { AgentLaunchMode, AgentPermissionMode, AgentProviderId } from '@shared/contracts/dto'

export type BuiltinAgentCommandProviderId = Exclude<AgentProviderId, 'pi' | 'kimi'>

interface OpenCodeServerBinding {
  hostname: string
  port: number
}

export interface BuildAgentLaunchCommandInput {
  provider: BuiltinAgentCommandProviderId
  mode: AgentLaunchMode
  prompt?: string
  model: string | null
  resumeSessionId: string | null
  /** Defaults to 'full' when omitted, matching the historical behaviour of this factory. */
  agentPermissionMode?: AgentPermissionMode
  opencodeServer?: OpenCodeServerBinding | null
  injectedArgs?: readonly string[]
}

export interface AgentLaunchCommand {
  command: string
  args: string[]
  launchMode: AgentLaunchMode
  effectiveModel: string | null
  resumeSessionId: string | null
}

export function resolveAgentCliCommand(provider: AgentProviderId): string {
  const commands: Record<AgentProviderId, string> = {
    'claude-code': 'claude',
    codex: 'codex',
    opencode: 'opencode',
    gemini: 'gemini',
    pi: 'pi',
    kimi: 'kimi',
  }
  return commands[provider]
}

function normalizeOptionalValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizePrompt(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function maybeTerminateOptionParsing(args: string[], value: string): void {
  if (value.startsWith('-')) {
    args.push('--')
  }
}

// Mapping of agentPermissionMode to provider flags:
// - claude-code: default -> `--permission-mode default` (explicit, so it never inherits the user's own
//   default mode, e.g. auto); auto -> `--permission-mode auto` (classifier-gated); full -> `--dangerously-skip-permissions`.
// - codex: default and auto both keep the approval-gated sandbox (auto is not a Codex mode yet); full -> bypass.
// - gemini / kimi / terminal catalog providers: only 'full' is full access, 'auto' counts as non-full.
function appendClaudeAccessArgs(args: string[], agentPermissionMode: AgentPermissionMode): void {
  if (agentPermissionMode === 'full') {
    args.push('--dangerously-skip-permissions')
    return
  }

  args.push('--permission-mode', agentPermissionMode)
}

function appendCodexAccessArgs(args: string[], agentPermissionMode: AgentPermissionMode): void {
  if (agentPermissionMode === 'full') {
    args.push('--dangerously-bypass-approvals-and-sandbox')
    return
  }

  args.push('--sandbox', 'workspace-write', '--ask-for-approval', 'on-request')
}

export function buildAgentLaunchCommand(input: BuildAgentLaunchCommandInput): AgentLaunchCommand {
  const effectiveModel = normalizeOptionalValue(input.model)
  const resumeSessionId = normalizeOptionalValue(input.resumeSessionId)
  const agentPermissionMode = input.agentPermissionMode ?? 'full'

  if (input.provider === 'claude-code') {
    if (!resumeSessionId) {
      throw new Error(`claude ${input.mode} requires explicit session id`)
    }

    const args: string[] = []
    appendClaudeAccessArgs(args, agentPermissionMode)

    if (effectiveModel) {
      args.push('--model', effectiveModel)
    }

    args.push(...(input.injectedArgs ?? []))

    if (input.mode === 'resume') {
      args.push('--resume', resumeSessionId)

      return {
        command: 'claude',
        args,
        launchMode: 'resume',
        effectiveModel,
        resumeSessionId,
      }
    }

    args.push('--session-id', resumeSessionId)
    const prompt = normalizePrompt(input.prompt)
    if (prompt.length > 0) {
      maybeTerminateOptionParsing(args, prompt)
      args.push(prompt)
    }

    return {
      command: 'claude',
      args,
      launchMode: 'new',
      effectiveModel,
      resumeSessionId,
    }
  }

  if (input.provider === 'opencode') {
    if (!input.opencodeServer) {
      throw new Error('opencode launch requires a reserved local server port')
    }

    const args = [
      '--hostname',
      input.opencodeServer.hostname,
      '--port',
      String(input.opencodeServer.port),
    ]

    if (effectiveModel) {
      args.push('--model', effectiveModel)
    }

    args.push(...(input.injectedArgs ?? []))

    if (input.mode === 'resume') {
      if (!resumeSessionId) {
        throw new Error('opencode resume requires explicit session id')
      }

      args.push('--session', resumeSessionId, '.')

      return {
        command: 'opencode',
        args,
        launchMode: 'resume',
        effectiveModel,
        resumeSessionId,
      }
    }

    const prompt = normalizePrompt(input.prompt)
    if (prompt.length > 0) {
      args.push('--prompt', prompt)
    }

    args.push('.')

    return {
      command: 'opencode',
      args,
      launchMode: 'new',
      effectiveModel,
      resumeSessionId: null,
    }
  }

  if (input.provider === 'gemini') {
    const args: string[] = []

    if (agentPermissionMode === 'full') {
      args.push('--yolo')
    }

    if (effectiveModel) {
      args.push('--model', effectiveModel)
    }

    args.push(...(input.injectedArgs ?? []))

    if (input.mode === 'resume') {
      if (!resumeSessionId) {
        throw new Error('gemini resume requires explicit session id')
      }

      args.push('--resume', resumeSessionId)

      return {
        command: 'gemini',
        args,
        launchMode: 'resume',
        effectiveModel,
        resumeSessionId,
      }
    }

    const prompt = normalizePrompt(input.prompt)
    if (prompt.length > 0) {
      args.push('--prompt-interactive', prompt)
    }

    return {
      command: 'gemini',
      args,
      launchMode: 'new',
      effectiveModel,
      resumeSessionId: null,
    }
  }

  if (input.mode === 'resume') {
    if (!resumeSessionId) {
      throw new Error('codex resume requires explicit session id')
    }

    const args: string[] = []
    appendCodexAccessArgs(args, agentPermissionMode)
    args.push(...(input.injectedArgs ?? []))
    args.push('resume', resumeSessionId)

    if (effectiveModel) {
      args.push('--model', effectiveModel)
    }

    return {
      command: 'codex',
      args,
      launchMode: 'resume',
      effectiveModel,
      resumeSessionId,
    }
  }

  const args: string[] = []
  appendCodexAccessArgs(args, agentPermissionMode)

  if (effectiveModel) {
    args.push('--model', effectiveModel)
  }

  args.push(...(input.injectedArgs ?? []))

  const prompt = normalizePrompt(input.prompt)
  if (prompt.length > 0) {
    maybeTerminateOptionParsing(args, prompt)
    args.push(prompt)
  }

  return {
    command: 'codex',
    args,
    launchMode: 'new',
    effectiveModel,
    resumeSessionId: null,
  }
}
