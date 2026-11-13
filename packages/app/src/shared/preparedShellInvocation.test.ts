import { describe, expect, it } from 'vitest'
import { planPreparedShellInvocation } from './preparedShellInvocation'

describe('offline shell review plans', () => {
  it('keeps Docker code on stdin and uses only the chosen existing container', () => {
    const code = 'echo "$HOME"; printf "review only"'
    const plan = planPreparedShellInvocation({ backend: 'docker', label: 'fixture', context: 'local', container: 'existing' }, code)
    expect(plan).toMatchObject({ stdin: code, executionEnabled: false, grantsPermission: false })
    expect(plan.options).toEqual(['--context', 'local', 'exec', '-i', 'existing', 'bash', '--noprofile', '--norc', '-s'])
    expect(plan.options).not.toContain(code)
  })
  it('requires a pinned host key and does not assemble a runnable SSH command', () => {
    const plan = planPreparedShellInvocation({ backend: 'ssh', label: 'fixture', host: 'host.example', user: 'fixture', port: 22, hostKeySha256: `SHA256:${'A'.repeat(43)}` }, 'echo fixture')
    expect(plan).toMatchObject({ requiresManagedKnownHosts: true, executionEnabled: false })
    expect(plan.options).toContain('StrictHostKeyChecking=yes')
    expect(plan.options).not.toContain('echo fixture')
    expect(() => planPreparedShellInvocation({ backend: 'database', label: 'fixture', relativePath: 'a.db', mode: 'read-only' }, 'never')).toThrow()
    expect(() => planPreparedShellInvocation({ backend: 'docker', label: 'fixture', context: 'local', container: 'existing' }, 'x'.repeat(6001))).toThrow()
  })
})
