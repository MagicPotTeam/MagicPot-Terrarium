import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'
import { createAdapter, objectSchema } from './helpers'

export const terminalToolAdapter = createAdapter([
  {
    ...bundledCreativeDeclarations['terminal.run'],
    inputSchema: objectSchema(
      {
        command: {
          type: 'string'
        },
        args: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        cwd: {
          type: 'string'
        },
        timeoutMs: {
          type: 'integer',
          minimum: 100,
          maximum: 30000
        }
      },
      ['command'],
      false
    ),
    dependency: 'terminalRun',
    permissionLevel: 'destructive',
    requiresConfirmation: true,
    disabledByDefault: true
  }
])
