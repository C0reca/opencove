import { describe, expect, it } from 'vitest'
import { buildAgentLaunchCommand } from '../../../src/contexts/agent/infrastructure/cli/AgentCommandFactory'

const claudeSessionId = '11111111-1111-4111-8111-111111111111'
const codexSafeArgs = ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']

describe('buildAgentLaunchCommand agentPermissionMode', () => {
  it('maps claude modes on new launches', () => {
    const base = {
      provider: 'claude-code' as const,
      mode: 'new' as const,
      prompt: 'hi',
      model: null,
      resumeSessionId: claudeSessionId,
    }
    expect(
      buildAgentLaunchCommand({ ...base, agentPermissionMode: 'default' }).args.slice(0, 2),
    ).toEqual(['--permission-mode', 'default'])
    expect(
      buildAgentLaunchCommand({ ...base, agentPermissionMode: 'auto' }).args.slice(0, 2),
    ).toEqual(['--permission-mode', 'auto'])
    expect(
      buildAgentLaunchCommand({ ...base, agentPermissionMode: 'full' }).args.slice(0, 1),
    ).toEqual(['--dangerously-skip-permissions'])
  })

  it('maps claude modes on resume', () => {
    const base = {
      provider: 'claude-code' as const,
      mode: 'resume' as const,
      model: null,
      resumeSessionId: claudeSessionId,
    }
    expect(buildAgentLaunchCommand({ ...base, agentPermissionMode: 'auto' }).args).toEqual([
      '--permission-mode',
      'auto',
      '--resume',
      claudeSessionId,
    ])
    expect(buildAgentLaunchCommand({ ...base, agentPermissionMode: 'full' }).args).toEqual([
      '--dangerously-skip-permissions',
      '--resume',
      claudeSessionId,
    ])
  })

  it('keeps codex auto on the approval-gated sandbox, same as default', () => {
    for (const agentPermissionMode of ['default', 'auto'] as const) {
      const command = buildAgentLaunchCommand({
        provider: 'codex',
        mode: 'new',
        prompt: 'x',
        model: null,
        resumeSessionId: null,
        agentPermissionMode,
      })
      expect(command.args.slice(0, 4)).toEqual(codexSafeArgs)
    }
    const full = buildAgentLaunchCommand({
      provider: 'codex',
      mode: 'resume',
      model: null,
      resumeSessionId: 'sess-1',
      agentPermissionMode: 'full',
    })
    expect(full.args[0]).toBe('--dangerously-bypass-approvals-and-sandbox')
  })
})
