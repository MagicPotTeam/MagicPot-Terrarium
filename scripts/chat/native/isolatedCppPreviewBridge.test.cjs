'use strict'

/* eslint-disable @typescript-eslint/no-require-imports -- CJS bridge is exercised with fake Electron and child-process modules. */

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { crc32, deflateSync } = require('node:zlib')

const CHANNEL = 'magicpot-isolated-cpp-preview-v1'
const PREFIX = 'data:image/png;base64,'
const source = fs.readFileSync(path.join(__dirname, 'isolatedCppPreviewBridge.cjs'), 'utf8')
const privateScratch = path.resolve(__dirname, '../../../../../.magicpot-trash')

function png(width = 2, height = 2) {
  const chunk = (kind, bytes) => {
    const result = Buffer.alloc(bytes.length + 12)
    result.writeUInt32BE(bytes.length)
    result.write(kind, 4, 'ascii')
    bytes.copy(result, 8)
    result.writeUInt32BE(crc32(result.subarray(4, 8 + bytes.length)), 8 + bytes.length)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const pixels = Buffer.alloc((width * 4 + 1) * height, 0)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function setup(t) {
  fs.mkdirSync(privateScratch, { recursive: true })
  const runRoot = fs.mkdtempSync(path.join(privateScratch, 'cpp-preview-bridge-test-'))
  const paths = {
    home: path.join(runRoot, 'home'),
    appData: path.join(runRoot, 'appdata'),
    temp: path.join(runRoot, 'temp')
  }
  for (const value of [
    ...Object.values(paths),
    path.join(runRoot, 'cwd'),
    path.join(runRoot, 'bin'),
    path.join(runRoot, 'app/out/renderer')
  ]) {
    fs.mkdirSync(value, { recursive: true })
  }
  const renderer = path.join(runRoot, 'app/out/renderer/index.html')
  fs.writeFileSync(renderer, '<!doctype html><title>synthetic</title>')
  const workerPath = path.join(runRoot, 'bin/fixture-worker.exe')
  fs.writeFileSync(workerPath, 'synthetic worker bytes; never executed')
  const workerSha256 = createHash('sha256').update(fs.readFileSync(workerPath)).digest('hex')
  const sender = new EventEmitter()
  const frame = {
    url: pathToFileURL(renderer).href + '#/canvas?id=synthetic',
    parent: null,
    isDestroyed: () => false
  }
  Object.assign(sender, {
    mainFrame: frame,
    isDestroyed: () => false,
    getURL: () => frame.url
  })
  const window = { webContents: sender, isDestroyed: () => false }
  const event = { sender, senderFrame: frame }
  const app = new EventEmitter()
  Object.assign(app, {
    isPackaged: false,
    getAppPath: () => path.join(runRoot, 'app'),
    getPath: (name) => paths[name]
  })
  const fakeProcess = new EventEmitter()
  Object.assign(fakeProcess, {
    platform: process.platform,
    env: {
      SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || 'C:/Windows',
      PRIVATE_TOKEN_MUST_NOT_INHERIT: 'synthetic-secret'
    }
  })
  const handlers = new Map(),
    children = [],
    timers = new Map()
  let clockId = 0,
    electronImports = 0
  const spawnCalls = []
  const spawn = (file, args, options) => {
    spawnCalls.push({ file, args, options })
    const child = new EventEmitter()
    child.pid = 60_000 + children.length
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.killSignals = []
    child.kill = (signal) => {
      child.killSignals.push(signal)
      return true
    }
    child.stdin.end = (bytes, callback) => {
      child.input = Buffer.from(bytes)
      callback()
    }
    child.finish = (output = png(), changes = {}, exitCode = 0) => {
      const diagnostic = {
        ok: exitCode === 0,
        error: '',
        hresult: '0x00000000',
        input_bytes: child.input.length,
        input_width: child.input.readUInt32BE(16),
        input_height: child.input.readUInt32BE(20),
        output_bytes: output.length,
        output_width: output.readUInt32BE(16),
        output_height: output.readUInt32BE(20),
        max_edge: 512,
        elapsed_ms: 1.25,
        memory_unit: 'bytes',
        memory_available: true,
        peak_working_set_bytes: 123456,
        peak_commit_bytes: 234567,
        end_private_bytes: 123000,
        ...changes
      }
      child.stdout.emit('data', output)
      child.stderr.emit('data', Buffer.from(JSON.stringify(diagnostic) + '\n'))
      child.emit('close', exitCode, null)
    }
    children.push(child)
    return child
  }
  const module = { exports: {} }
  const context = vm.createContext({
    module,
    exports: module.exports,
    Buffer,
    URL,
    process: fakeProcess,
    __MAGICPOT_IMAGE_DESKTOP__: { runRoot },
    setTimeout: (callback, milliseconds) => {
      const id = ++clockId
      timers.set(id, { callback, milliseconds })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    require: (name) => {
      if (name === 'electron') {
        electronImports++
        return {
          app,
          BrowserWindow: { fromWebContents: (value) => (value === sender ? window : undefined) },
          ipcMain: {
            handle(channel, handler) {
              assert.equal(handlers.has(channel), false)
              handlers.set(channel, handler)
            },
            removeHandler: (channel) => handlers.delete(channel)
          }
        }
      }
      if (name === 'node:child_process') return { spawn }
      return require(name)
    }
  })
  vm.runInContext(source, context, { filename: 'isolatedCppPreviewBridge.cjs' })
  let installed
  const install = async (extra = {}) => {
    installed = await module.exports.installIsolatedCppPreviewBridge({
      runRoot,
      workerPath,
      workerSha256,
      enabled: true,
      ...extra
    })
    return installed
  }
  t.after(() => {
    installed?.dispose()
    for (const child of children) child.emit('close', null, 'SIGKILL')
    fs.rmSync(runRoot, { recursive: true, force: true })
  })
  return {
    install,
    exports: module.exports,
    context,
    handlers,
    children,
    timers,
    spawnCalls,
    runRoot,
    workerPath,
    event,
    sender,
    frame,
    app,
    fakeProcess,
    importedElectron: () => electronImports,
    request: (args = { dataUrl: PREFIX + png().toString('base64') }, suppliedEvent = event) =>
      handlers.get(CHANNEL)(suppliedEvent, args),
    stats: () => JSON.parse(JSON.stringify(context.__MAGICPOT_CPP_PREVIEW_STATS__.snapshot()))
  }
}

test('import is inert; preload exposes only the fixed request channel and enabled flag', async (t) => {
  const h = setup(t)
  assert.equal(h.importedElectron(), 0)
  assert.equal(h.spawnCalls.length, 0)
  let exposed, invoked
  vm.runInNewContext(h.exports.createIsolatedCppPreviewPreloadSource({ enabled: true }), {
    require(name) {
      assert.equal(name, 'electron')
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            exposed = { name, value }
          }
        },
        ipcRenderer: {
          invoke(channel, args) {
            invoked = { channel, args }
            return Promise.resolve('reply')
          }
        }
      }
    }
  })
  assert.equal(exposed.name, '__MAGICPOT_CPP_PREVIEW__')
  assert.equal(exposed.value.enabled, true)
  assert.deepEqual(Object.keys(exposed.value).sort(), ['enabled', 'request'])
  assert.equal(Object.isFrozen(exposed.value), true)
  const args = { dataUrl: 'synthetic' }
  assert.equal(await exposed.value.request(args), 'reply')
  assert.equal(invoked.channel, CHANNEL)
  assert.equal(invoked.args, args)
  assert.throws(() => h.exports.createIsolatedCppPreviewPreloadSource({ enabled: 'true' }))
})

test('verified private worker receives only PNG bytes and fixed 512 arguments', async (t) => {
  const h = setup(t)
  await h.install()
  const response = h.request()
  assert.equal(h.stats().inFlight, 1)
  const call = h.spawnCalls[0]
  assert.equal(call.file, h.workerPath)
  assert.deepEqual([...call.args], ['--max-edge', '512'])
  assert.equal(call.options.shell, false)
  assert.equal(call.options.cwd, path.join(h.runRoot, 'cwd'))
  assert.equal(call.options.env.PRIVATE_TOKEN_MUST_NOT_INHERIT, undefined)
  assert.equal(call.options.env.PATH, undefined)
  assert(h.children[0].input.equals(png()))
  h.children[0].finish()
  const result = await response
  assert.equal(result.width, 2)
  assert.equal(result.height, 2)
  assert.equal(result.dataUrl, PREFIX + png().toString('base64'))
  const stats = h.stats()
  assert.equal(stats.requests, 1)
  assert.equal(stats.completed, 1)
  assert.equal(stats.rejected, 0)
  assert.equal(stats.inFlight, 0)
  assert.equal(stats.workers[0].peakWorkingSetBytes, 123456)
  assert.equal(stats.workers[0].peakCommitBytes, 234567)
  assert.equal(stats.workers[0].pid, 60000)
  assert.equal(stats.workers[0].status, 'completed')
  assert.equal(JSON.stringify(stats).includes(h.runRoot), false)
  assert.equal(JSON.stringify(stats).includes('data:image'), false)
})

test('disabled bridge, subframes and another renderer URL cannot spawn a child', async (t) => {
  const disabled = setup(t)
  await disabled.install({ enabled: false })
  await assert.rejects(disabled.request(), /DISABLED/)
  assert.equal(disabled.children.length, 0)
  const h = setup(t)
  await h.install()
  await assert.rejects(
    h.request(undefined, { ...h.event, senderFrame: { ...h.frame, parent: h.frame } }),
    /SENDER/
  )
  h.frame.url = 'file:///D:/not-this-run/index.html'
  await assert.rejects(h.request(), /SENDER/)
  assert.equal(h.children.length, 0)
})

test('rejects wrong hash, outside executable and a changed worker before spawn', async (t) => {
  const h = setup(t)
  await assert.rejects(h.install({ workerSha256: '0'.repeat(64) }), /WORKER_HASH/)
  await assert.rejects(h.install({ workerPath: __filename }), /PRIVATE_PATH/)
  await h.install()
  fs.appendFileSync(h.workerPath, 'changed')
  await assert.rejects(h.request(), /WORKER_CHANGED/)
  assert.equal(h.children.length, 0)
})

test('requires canonical bounded PNG base64 and an exact one-field request', async (t) => {
  const h = setup(t)
  await h.install()
  const good = PREFIX + png().toString('base64')
  const badCrc = png()
  badCrc[29] ^= 1
  const invalid = [
    null,
    {},
    { dataUrl: good, path: 'private' },
    { url: good },
    { dataUrl: 'file:///synthetic.png' },
    { dataUrl: good.replace(';base64,', ';base64,\n') },
    { dataUrl: PREFIX + 'AA=A' },
    { dataUrl: PREFIX + 'AB==' },
    { dataUrl: PREFIX + badCrc.toString('base64') },
    { dataUrl: PREFIX + 'A'.repeat(Math.ceil((20 * 1024 * 1024) / 3) * 4 + 4) }
  ]
  for (const input of invalid)
    await assert.rejects(h.request(input), /Isolated C\+\+ preview rejected/)
  assert.equal(h.children.length, 0)
  assert.equal(h.stats().rejected, invalid.length)
})

test('busy requests never queue; a timeout retains the slot until owned child close', async (t) => {
  const h = setup(t)
  await h.install()
  const response = h.request()
  await assert.rejects(h.request(), /BUSY/)
  assert.equal(h.children.length, 1)
  const rejected = assert.rejects(response, /TIMEOUT/)
  const timer = [...h.timers.values()].find((item) => item.milliseconds === 15_000)
  assert(timer)
  timer.callback()
  await rejected
  assert.deepEqual(h.children[0].killSignals, ['SIGKILL'])
  assert.equal(h.stats().inFlight, 1)
  await assert.rejects(h.request(), /BUSY/)
  h.children[0].emit('close', null, 'SIGKILL')
  assert.equal(h.stats().inFlight, 0)
  assert.equal(h.stats().workers[0].status, 'failed')
  assert.equal(h.stats().workers[0].errorCode, 'TIMEOUT')
})

test('stdout and stderr limits terminate only the owned child', async (t) => {
  for (const [stream, limit, code] of [
    ['stdout', 2 * 1024 * 1024, 'STDOUT_LIMIT'],
    ['stderr', 8 * 1024, 'STDERR_LIMIT']
  ]) {
    const h = setup(t)
    await h.install()
    const response = h.request()
    const rejected = assert.rejects(response, new RegExp(code))
    h.children[0][stream].emit('data', Buffer.alloc(limit + 1))
    await rejected
    assert.deepEqual(h.children[0].killSignals, ['SIGKILL'])
    assert.equal(h.stats().inFlight, 1)
    h.children[0].emit('close', null, 'SIGKILL')
    assert.equal(h.stats().inFlight, 0)
  }
})

test('invalid output size, CRC or diagnostic metadata never return the original image', async (t) => {
  const scenarios = [
    (child) => child.finish(png(513, 1)),
    (child) => {
      const output = png()
      output[29] ^= 1
      child.finish(output)
    },
    (child) => child.finish(png(), { output_bytes: 1 }),
    (child) => child.finish(png(), { ok: false }, 1)
  ]
  for (const finish of scenarios) {
    const h = setup(t)
    await h.install()
    const response = h.request()
    const rejected = assert.rejects(response, /Isolated C\+\+ preview rejected/)
    finish(h.children[0])
    await rejected
    assert.equal(h.stats().completed, 0)
    assert.equal(h.stats().rejected, 1)
  }
})

test('main-frame navigation and parent shutdown cancel only this active worker', async (t) => {
  const h = setup(t)
  await h.install()
  const first = h.request()
  const navigationRejected = assert.rejects(first, /SENDER_CHANGED/)
  h.sender.emit('did-start-navigation', { isMainFrame: true })
  await navigationRejected
  h.children[0].emit('close', null, 'SIGKILL')
  const second = h.request()
  const shutdownRejected = assert.rejects(second, /SHUTDOWN/)
  h.fakeProcess.emit('exit', 0)
  await shutdownRejected
  assert.equal(h.handlers.has(CHANNEL), false)
  assert.deepEqual(
    h.children.map((child) => child.killSignals),
    [['SIGKILL'], ['SIGKILL']]
  )
  h.children[1].emit('close', null, 'SIGKILL')
  assert.equal(h.stats().closed, true)
  assert.equal(h.stats().inFlight, 0)
})

test('records remain bounded and absent worker memory is not reported as zero', async (t) => {
  const h = setup(t)
  await h.install()
  for (let index = 0; index < 66; index++) {
    const response = h.request()
    h.children.at(-1).finish(png(), {
      memory_available: false,
      peak_working_set_bytes: 0,
      peak_commit_bytes: 0,
      end_private_bytes: 0
    })
    await response
  }
  const stats = h.stats()
  assert.equal(stats.completed, 66)
  assert.equal(stats.workers.length, 64)
  assert.equal(stats.workers[0].sequence, 3)
  assert.equal(stats.workers.at(-1).memoryAvailable, false)
  assert.equal(stats.workers.at(-1).peakWorkingSetBytes, null)
  assert.equal(stats.workers.at(-1).peakCommitBytes, null)
})
