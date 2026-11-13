import { describe, expect, it } from 'vitest'
import { createExecutionPreparation } from './executionPreparation'

describe('offline execution preparation only', () => {
  const ssh = { backend: 'ssh', label: 'fixture', host: 'host.example', port: 22, user: 'fixture', hostKeySha256: `SHA256:${'A'.repeat(43)}` }
  it('validates three distinct non-executable plans', () => {
    for (const input of [ssh, { backend: 'docker', label: 'fixture', context: 'local', container: 'existing-1' },
      { backend: 'database', label: 'fixture', relativePath: 'data/fixture.sqlite', mode: 'read-only' }]) {
      expect(createExecutionPreparation(input)).toMatchObject({ executionEnabled: false, verified: false, grantsPermission: false })
    }
  })
  it('rejects credentials, commands, host injection and database escapes/write mode', () => {
    for (const input of [{ ...ssh, password: 'never' }, { ...ssh, host: '-oProxyCommand=bad' }, { ...ssh, port: 0 },
      { ...ssh, hostKeySha256: '' }, { ...ssh, command: 'never' },
      { backend: 'docker', label: 'fixture', context: 'local', container: '--privileged' },
      ...['../private.db', '/private.db', 'C:/private.db', 'data//a.db', 'data/a.txt'].map(relativePath => ({ backend: 'database', label: 'fixture', relativePath, mode: 'read-only' })),
      { backend: 'database', label: 'fixture', relativePath: 'data/a.db', mode: 'write' }]) {
      expect(() => createExecutionPreparation(input)).toThrow()
    }
  })
})
