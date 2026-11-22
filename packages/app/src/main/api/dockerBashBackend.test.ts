import { describe, expect, it, vi } from 'vitest'
import { createDockerBashBackend, createDockerOutputCollector, decodeDockerOutput, type DockerTransport } from './dockerBashBackend'
function frame(text: string, stream = 1) { const data = Buffer.from(text), head = Buffer.alloc(8); head[0] = stream; head.writeUInt32BE(data.length, 4); return Buffer.concat([head, data]) }
describe('upstream Docker persistent backend', () => {
  it('retains only capped Unicode output while consuming fragmented frames', () => {
    const collector = createDockerOutputCollector(3)
    const bytes = Buffer.concat([frame('a😀'), frame('bc'.repeat(10000), 2)])
    for (let index=0; index<bytes.length; index+=7) collector.push(bytes.subarray(index,index+7))
    const result = collector.finishFrame()
    expect(decodeDockerOutput(result)).toBe('a😀b')
    expect(result.totalOutputChars).toBe(20002)
    expect(result.length).toBeLessThan(32)
  })
  it('lazily creates sleep container, reuses state, merges streams/truncates and stop/removes on close', async () => {
    const calls: Array<{ route: string; body: unknown }> = []
    const transport: DockerTransport = vi.fn(async (_method, route, body) => {
      calls.push({ route, body })
      if (route.startsWith('/containers/create')) return Buffer.from('{"Id":"owned"}')
      if (route === '/containers/owned/json') return Buffer.from('{"State":{"Running":true}}')
      if (route.endsWith('/exec')) return Buffer.from('{"Id":"run"}')
      if (route === '/exec/run/start') return Buffer.concat([frame('hello'), frame('err', 2)])
      if (route === '/exec/run/json') return Buffer.from('{"ExitCode":3}')
      return Buffer.alloc(0)
    })
    const backend = createDockerBashBackend({ image: 'fixture', volumes: ['{cwd}:/workspace'], env: { FIXTURE: 'yes' }, auto_remove: false, max_result_size_chars: 6 }, transport)
    expect(calls).toHaveLength(0)
    expect(await backend.execute('touch state', process.cwd())).toMatchObject({ exitCode: 3, output: 'helloe\n... (truncated, 2 chars omitted)' })
    await backend.execute('cat state', process.cwd(), 'sh')
    expect(calls.filter(call => call.route.startsWith('/containers/create'))).toHaveLength(1)
    expect(calls[0].body).toMatchObject({ Image: 'fixture', Cmd: ['sleep', 'infinity'], HostConfig: { AutoRemove: false } })
    expect(calls.filter(call => call.route.endsWith('/exec'))[1].body).toMatchObject({ Cmd: ['sh', '-c', 'cat state'] })
    await backend.close(); await backend.close()
    expect(calls.filter(call => call.route.includes('/stop?'))).toHaveLength(1)
    expect(calls.some(call => call.route === '/containers/owned?force=1')).toBe(true)
  })
  it('local timeout also releases waiting on stalled lazy creation', async () => {
    vi.useFakeTimers()
    try {
      let finish!: (value: Buffer) => void
      const transport: DockerTransport = vi.fn(async (_method, route) => route.startsWith('/containers/create') ? new Promise<Buffer>(resolve => { finish = resolve }) : Buffer.alloc(0))
      const backend = createDockerBashBackend({}, transport)
      const pending = backend.execute('echo fixture', process.cwd(), 'bash', 1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await pending).toMatchObject({ remoteMayContinue: true })
      finish(Buffer.from('{"Id":"owned"}'))
      await backend.close()
    } finally { vi.useRealTimers() }
  })
  it('times out local waiting without stopping container or remote command', async () => {
    vi.useFakeTimers()
    try {
      const transport: DockerTransport = vi.fn(async (_method, route, _body, signal) => {
        if (route.startsWith('/containers/create')) return Buffer.from('{"Id":"owned"}')
        if (route.endsWith('/exec')) return Buffer.from('{"Id":"run"}')
        if (route === '/exec/run/start') return new Promise<Buffer>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('local aborted')), { once: true }))
        return Buffer.alloc(0)
      })
      const backend = createDockerBashBackend({}, transport)
      const result = backend.execute('sleep 60', process.cwd(), 'bash', 1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await result).toMatchObject({ remoteMayContinue: true, error: 'Command timed out after 1s' })
      expect(vi.mocked(transport).mock.calls.some(call => call[1].includes('/stop'))).toBe(false)
      await backend.close()
    } finally { vi.useRealTimers() }
  })
})
