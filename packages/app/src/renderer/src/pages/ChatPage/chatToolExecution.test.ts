import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { SkillRuntimeSpec } from './chatSkillRuntime'
import {
  buildToolCommandExample,
  buildToolInputSchemaSummary,
  buildToolRouteDraftForChatSession,
  executeExplicitSkillToolCommand,
  parseExplicitToolCommand,
  resolveAllowedSkillTools,
  resolveAllowedSkillToolNames
} from './chatToolExecution'

const createRuntime = (
  toolNames: string[],
  options?: { toolInputSchemas?: Record<string, Record<string, unknown> | undefined> }
): SkillRuntimeSpec => ({
  skill: null,
  instructions: {},
  execution: {
    mode: 'inherit',
    allowHistory: true,
    outputMode: 'chat',
    fallbackStrategy: 'default',
    persistSessionUrl: true
  },
  resources: [],
  scripts: [],
  boundApps: [],
  boundBindings: toolNames.length
    ? [
        {
          app: {
            id: 'mcp.test',
            name: 'Test MCP',
            description: 'Test',
            enabled: true,
            status: 'ready',
            transport: 'mcp',
            source: 'mcp-client',
            capabilities: {
              tools: toolNames.map((name) => ({
                name,
                ...(options?.toolInputSchemas?.[name]
                  ? { inputSchema: options.toolInputSchemas[name] }
                  : {})
              })),
              resources: []
            }
          },
          toolNames,
          resourceUris: []
        }
      ]
    : [],
  unavailableBindings: []
})

describe('chatToolExecution', () => {
  it('parses /tool commands and falls back to raw input payloads', () => {
    expect(parseExplicitToolCommand('/tool session.status {"limit":2}')).toEqual({
      toolName: 'session.status',
      args: { limit: 2 }
    })
    expect(parseExplicitToolCommand('/tool session.summary show me')).toEqual({
      toolName: 'session.summary',
      args: { input: 'show me' }
    })
    expect(parseExplicitToolCommand('hello')).toBeNull()
  })

  it('resolves a stable route draft and unique allowed tools', () => {
    expect(buildToolRouteDraftForChatSession(' session-1 ')).toEqual({
      channel: 'generic',
      scopeType: 'thread',
      scopeId: 'session-1',
      threadId: 'session-1'
    })
    expect(resolveAllowedSkillTools(createRuntime(['session.status', 'session.status']))).toEqual([
      { name: 'session.status' }
    ])
    expect(
      resolveAllowedSkillToolNames(createRuntime(['session.status', 'session.status']))
    ).toEqual(['session.status'])
  })

  it('summarizes tool schemas and produces aligned command examples', () => {
    const tool = {
      name: 'workspace.inspect',
      description: 'Inspect a recorded workspace identity by workspaceId.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          runLimit: { type: 'integer', minimum: 1, maximum: 100 }
        },
        required: ['workspaceId']
      }
    }

    expect(buildToolInputSchemaSummary(tool)).toBe('JSON object; required: workspaceId')
    expect(buildToolCommandExample(tool)).toBe('/tool workspace.inspect {\n  "workspaceId": ""\n}')
  })

  it('executes explicit tool commands through the chat tool client with an allowlist', async () => {
    const callToolImpl = vi.fn(async () => ({
      content: 'ok',
      metadata: { executed: true }
    }))

    const result = await executeExplicitSkillToolCommand({
      commandText: '/tool session.status {"verbose":true}',
      runtime: createRuntime(['session.status', 'session.summary']),
      sessionId: 'chat-session-1',
      config: DEFAULT_CONFIG,
      authSecret: 'secret',
      callToolImpl
    })

    expect(result).toEqual({
      content: 'ok',
      metadata: { executed: true }
    })
    expect(callToolImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        route: {
          channel: 'generic',
          scopeType: 'thread',
          scopeId: 'chat-session-1',
          threadId: 'chat-session-1'
        },
        toolName: 'session.status',
        args: { verbose: true },
        allowedToolNames: ['session.status', 'session.summary'],
        authSecret: 'secret'
      })
    )
  })

  it('rejects explicit tool commands whose payload does not satisfy the declared schema', async () => {
    await expect(
      executeExplicitSkillToolCommand({
        commandText: '/tool workspace.inspect show me',
        runtime: createRuntime(['workspace.inspect'], {
          toolInputSchemas: {
            'workspace.inspect': {
              type: 'object',
              properties: {
                workspaceId: { type: 'string' },
                runLimit: { type: 'integer', minimum: 1, maximum: 100 }
              },
              required: ['workspaceId']
            }
          }
        }),
        sessionId: 'chat-session-1',
        config: DEFAULT_CONFIG,
        callToolImpl: vi.fn()
      })
    ).rejects.toThrow(
      'Tool "workspace.inspect" requires JSON object; required: workspaceId. missing required field "workspaceId".'
    )
  })

  it('preserves free-form text for empty object tool schemas', async () => {
    const callToolImpl = vi.fn(async () => ({
      content: 'ok'
    }))

    await executeExplicitSkillToolCommand({
      commandText: '/tool session.status show me',
      runtime: createRuntime(['session.status'], {
        toolInputSchemas: {
          'session.status': {
            type: 'object',
            properties: {}
          }
        }
      }),
      sessionId: 'chat-session-1',
      config: DEFAULT_CONFIG,
      callToolImpl
    })

    expect(callToolImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'session.status',
        args: { input: 'show me' }
      })
    )
  })

  it('rejects explicit tool commands that are not bound to the current skill', async () => {
    await expect(
      executeExplicitSkillToolCommand({
        commandText: '/tool session.summary',
        runtime: createRuntime(['session.status']),
        sessionId: 'chat-session-1',
        config: DEFAULT_CONFIG,
        callToolImpl: vi.fn()
      })
    ).rejects.toThrow('Tool "session.summary" is not bound to the current skill.')
  })
})
