import { generateKeyPairSync } from 'node:crypto'
import { Server } from 'ssh2'
import { describe, expect, it } from 'vitest'
import { connectSsh2SessionWithKnownHosts } from './ssh2SessionConnector'
import { createSshBashBackend } from './sshBashBackend'
describe('real ssh2 loopback connector, synthetic credentials only', () => {
  it('authenticates, quotes shell command, reuses connection and closes session', async () => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
    let connections = 0
    const commands: string[] = []
    const server = new Server({ hostKeys: [key] }, client => {
      connections++
      client.on('authentication', context => { if (context.method === 'password' && context.username === 'synthetic' && context.password === 'test-only') context.accept(); else context.reject() })
      client.on('ready', () => client.on('session', accept => accept().on('exec', (acceptExec, _reject, info) => {
        commands.push(info.command)
        const channel = acceptExec()
        if (info.command === 'sh -c no-status') { channel.end(); return }
        if (info.command === 'sh -c oversized') { channel.write('a'.repeat(100)); channel.exit(0); channel.end(); return }
        channel.write('fixture'); channel.stderr.write('diagnostic'); channel.exit(7); channel.end()
      })))
      client.on('error', () => {})
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Loopback fixture did not listen')
    const backend = createSshBashBackend({ host:'127.0.0.1',port:address.port,user:'synthetic',password:'test-only' }, config => connectSsh2SessionWithKnownHosts(config, ''))
    try {
      expect(await backend.execute('echo fixture')).toMatchObject({ output:'fixture\ndiagnostic',exitCode:7 })
      await backend.execute('pwd','sh')
      const capped = createSshBashBackend({host:'127.0.0.1',port:address.port,user:'synthetic',password:'test-only',max_result_size_chars:4}, config=>connectSsh2SessionWithKnownHosts(config,''))
      try { expect(await capped.execute('oversized','sh')).toMatchObject({output:'aaaa\n... (truncated, 96 chars omitted)'}) } finally { await capped.close() }
      expect(connections).toBe(2)
      expect(commands).toEqual(["bash -c 'echo fixture'",'sh -c pwd','sh -c oversized'])
      expect(await backend.execute('no-status','sh')).toMatchObject({exitCode:-1})
      await expect(connectSsh2SessionWithKnownHosts({ host:'127.0.0.1',port:address.port,user:'synthetic',password:'test-only',known_hosts_policy:'auto_add' }, `@revoked [127.0.0.1]:${address.port} ssh-rsa AAAA`)).rejects.toThrow('SSH connection or authentication failed')
    } finally { await backend.close(); await new Promise<void>(resolve=>server.close(()=>resolve())) }
  },15000)
})
