import { createAdapter, objectSchema } from './helpers'

export const terminalToolAdapter = createAdapter([
  {
    name: 'terminal.run',
    category: 'terminal',
    description:
      'Thin wrapper for running an explicitly enabled, policy-controlled terminal command adapter.',
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
