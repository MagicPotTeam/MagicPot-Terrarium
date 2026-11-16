// Fake platforms, fake /proc trees and fake spawn: no Electron, no cargo, no display, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  LINUX_OWNER_ENV, LINUX_XVFB_ENV, RUN_ROOT_MARKER_ENV,
  isolatedWorkerPath, isolatedWorkerSourceArgument, isolatedElectronArgs, linuxIsolatedEnvironment,
  assertFreshIsolatedRunRoot, buildLinuxIsolatedWorker, needsLinuxXvfbRelaunch, linuxXvfbCommand,
  listOwnedLinuxProcesses, parseProcNetTable, isLoopbackAddress, sampleLinuxSockets, createLinuxRunObserver,
  cleanupOwnedLinuxProcesses, relaunchIsolatedRunnerUnderXvfb
} from './isolatedDesktopPlatform.mjs'

async function scratch(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'k5-platform-')))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

async function freshRoot(t, entries = ['app']) {
  const privateRoot = path.join(await scratch(t), '.magicpot-trash')
  const runRoot = path.join(privateRoot, 'MagicPot', 'k5-unit-run')
  await fs.mkdir(runRoot, { recursive: true })
  for (const entry of entries) await fs.mkdir(path.join(runRoot, entry))
  return { privateRoot, runRoot }
}

async function fakeProcess(procRoot, pid, { env = {}, comm = 'proc', pgid = pid, sockets = [] } = {}) {
  const dir = path.join(procRoot, String(pid))
  await fs.mkdir(path.join(dir, 'fd'), { recursive: true })
  await fs.writeFile(path.join(dir, 'environ'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\0') + '\0')
  await fs.writeFile(path.join(dir, 'stat'), `${pid} (${comm}) S 1 ${pgid} ${pgid} 0 -1`)
  for (const [index, inode] of sockets.entries()) await fs.symlink(`socket:[${inode}]`, path.join(dir, 'fd', String(index + 3)))
  return dir
}

const tcpHeader = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
const tcpRow = (sl, local, remote, state, inode) => `  ${sl}: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000     0        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`

test('worker path: win32 keeps the original .exe location, linux uses the cargo binary name', () => {
  const root = '/r/MagicPot/run'
  assert.equal(isolatedWorkerPath(root, 'win32'), path.join(root, 'bin/canvas-thumbnail-sidecar.exe'))
  assert.equal(isolatedWorkerPath(root, 'linux'), path.join(root, 'bin', 'canvas-thumbnail-sidecar'))
})

test('worker argument: win32 resolves it exactly as before, linux refuses any worker path', () => {
  assert.equal(isolatedWorkerSourceArgument('relative/worker.exe', 'win32'), path.resolve('relative/worker.exe'))
  assert.equal(isolatedWorkerSourceArgument(undefined, 'linux'), undefined)
  assert.throws(() => isolatedWorkerSourceArgument('/private/worker.exe', 'linux'), /built from packages\/canvas-thumbnail-sidecar/)
})

test('electron args: win32 returns the same array, linux appends --no-sandbox only', () => {
  const args = ['/app', '--user-data-dir=/d']
  assert.equal(isolatedElectronArgs(args, 'win32'), args)
  assert.deepEqual(isolatedElectronArgs(args, 'linux'), [...args, '--no-sandbox'])
  assert.deepEqual(args, ['/app', '--user-data-dir=/d'])
})

test('linux environment stays inside the run root and copies only the display from the host', () => {
  const env = linuxIsolatedEnvironment('/p/MagicPot/run', { DISPLAY: ':99', XAUTHORITY: '/tmp/x/Xauthority', HOME: '/root', SECRET_TOKEN: 'x', NODE_OPTIONS: '--inspect' })
  assert.deepEqual(env, {
    HOME: '/p/MagicPot/run/home',
    XDG_CONFIG_HOME: '/p/MagicPot/run/home/.config',
    XDG_CACHE_HOME: '/p/MagicPot/run/home/.cache',
    XDG_DATA_HOME: '/p/MagicPot/run/home/.local/share',
    TMPDIR: '/p/MagicPot/run/temp',
    LANG: 'zh_CN.UTF-8',
    MAGICPOT_PRIVATE_TEST_SKIP_LEGACY_USER_DATA_MIGRATION: '1',
    MAGICPOT_PRIVATE_LIVE_SYNC: '0',
    DISPLAY: ':99',
    XAUTHORITY: '/tmp/x/Xauthority'
  })
})

test('fresh root: only app/ is accepted; a used, misplaced or symlinked root is refused', async t => {
  const fresh = await freshRoot(t)
  await assertFreshIsolatedRunRoot(fresh.runRoot, fresh.privateRoot)
  for (const extra of ['evidence', 'storage', 'bin']) {
    const used = await freshRoot(t, ['app', extra])
    await assert.rejects(assertFreshIsolatedRunRoot(used.runRoot, used.privateRoot), /never-run root/)
  }
  const empty = await freshRoot(t, [])
  await assert.rejects(assertFreshIsolatedRunRoot(empty.runRoot, empty.privateRoot), /never-run root/)
  await assert.rejects(assertFreshIsolatedRunRoot(path.join(fresh.privateRoot, 'elsewhere'), fresh.privateRoot), /MagicPot\/<run id>/)
  const link = path.join(fresh.privateRoot, 'MagicPot', 'k5-link')
  await fs.symlink(fresh.runRoot, link)
  await assert.rejects(assertFreshIsolatedRunRoot(link, fresh.privateRoot), /canonical/)
  const appLink = await freshRoot(t, [])
  await fs.symlink(fresh.runRoot, path.join(appLink.runRoot, 'app'))
  await assert.rejects(assertFreshIsolatedRunRoot(appLink.runRoot, appLink.privateRoot), /owned by this root/)
})

function fakeCargo({ code = 0, binary = 'ELF-fake-worker' } = {}) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.kill = () => true
    setImmediate(async () => {
      if (code === 0) {
        await fs.mkdir(path.join(options.env.CARGO_TARGET_DIR, 'release'), { recursive: true })
        await fs.writeFile(path.join(options.env.CARGO_TARGET_DIR, 'release', 'canvas-thumbnail-sidecar'), binary)
      }
      child.emit('close', code, null)
    })
    return child
  }
  return { calls, spawn }
}

test('linux worker: cargo build --locked of the sidecar manifest into the run root, then an exclusive copy', async t => {
  const { runRoot } = await freshRoot(t)
  await fs.mkdir(path.join(runRoot, 'bin'))
  const cargo = fakeCargo()
  const result = await buildLinuxIsolatedWorker(runRoot, { platform: 'linux', spawn: cargo.spawn, env: { PATH: '/usr/bin', HOME: '/root' } })
  assert.equal(cargo.calls.length, 1)
  const [call] = cargo.calls
  assert.equal(call.command, 'cargo')
  assert.deepEqual(call.args.slice(0, 4), ['build', '--locked', '--release', '--manifest-path'])
  assert.match(call.args[4], /packages[/\\]canvas-thumbnail-sidecar[/\\]Cargo\.toml$/)
  assert.equal(call.options.env.CARGO_TARGET_DIR, path.join(runRoot, 'worker-target'))
  assert.equal(call.options.shell, false)
  assert.equal(result.workerPath, path.join(runRoot, 'bin', 'canvas-thumbnail-sidecar'))
  assert.equal(await fs.readFile(result.workerPath, 'utf8'), 'ELF-fake-worker')
  assert.equal((await fs.stat(result.workerPath)).mode & 0o777, 0o755)
  assert.match(result.sha256, /^[0-9a-f]{64}$/)
  // A second build on the same root is refused before cargo runs.
  await assert.rejects(buildLinuxIsolatedWorker(runRoot, { platform: 'linux', spawn: cargo.spawn }), /EEXIST/)
  assert.equal(cargo.calls.length, 1)
})

test('linux worker: a failed cargo build copies nothing; the build is refused on win32', async t => {
  const { runRoot } = await freshRoot(t)
  await fs.mkdir(path.join(runRoot, 'bin'))
  await assert.rejects(buildLinuxIsolatedWorker(runRoot, { platform: 'linux', spawn: fakeCargo({ code: 101 }).spawn }), /cargo build --locked .* failed \(exit 101\)/)
  assert.deepEqual(await fs.readdir(path.join(runRoot, 'bin')), [])
  const cargo = fakeCargo()
  await assert.rejects(buildLinuxIsolatedWorker(runRoot, { platform: 'win32', spawn: cargo.spawn }), /only used on Linux/)
  assert.equal(cargo.calls.length, 0)
})

test('xvfb relaunch is needed only on linux outside the wrapper', () => {
  assert.equal(needsLinuxXvfbRelaunch('win32', {}), false)
  assert.equal(needsLinuxXvfbRelaunch('darwin', {}), false)
  assert.equal(needsLinuxXvfbRelaunch('linux', {}), true)
  assert.equal(needsLinuxXvfbRelaunch('linux', { [LINUX_XVFB_ENV]: '1' }), false)
  const plan = linuxXvfbCommand({ script: '/repo/scripts/chat/runner.mjs', args: ['/root/run'], execPath: '/node', env: { PATH: '/bin' }, owner: 'owner-1' })
  assert.equal(plan.command, 'xvfb-run')
  assert.deepEqual(plan.args, ['-a', '-s', '-screen 0 1920x1200x24', '/node', '/repo/scripts/chat/runner.mjs', '/root/run'])
  assert.deepEqual(plan.env, { PATH: '/bin', [LINUX_XVFB_ENV]: '1', [LINUX_OWNER_ENV]: 'owner-1' })
})

test('owned processes are matched only by this run owner token or run-root marker', async t => {
  const procRoot = path.join(await scratch(t), 'proc')
  await fakeProcess(procRoot, 100, { env: { [LINUX_OWNER_ENV]: 'mine' }, comm: 'Xvfb' })
  await fakeProcess(procRoot, 101, { env: { [RUN_ROOT_MARKER_ENV]: '/p/MagicPot/run' }, comm: 'electron' })
  await fakeProcess(procRoot, 102, { env: { [LINUX_OWNER_ENV]: 'other' }, comm: 'foreign' })
  await fakeProcess(procRoot, 103, { env: { [RUN_ROOT_MARKER_ENV]: '/p/MagicPot/run-2' }, comm: 'other-run' })
  await fakeProcess(procRoot, 104, { env: { NOTE: `${LINUX_OWNER_ENV}=mine` }, comm: 'lookalike' })
  await fakeProcess(procRoot, 105, { env: { [LINUX_OWNER_ENV]: 'mine' }, comm: 'self' })
  const owned = await listOwnedLinuxProcesses({ owner: 'mine', runRoot: '/p/MagicPot/run', procRoot, selfPid: 105 })
  assert.deepEqual(owned.map(item => [item.pid, item.comm]).sort(), [[100, 'Xvfb'], [101, 'electron']])
})

test('proc net tables decode loopback, remote IPv4/IPv6 and listening sockets', () => {
  const v4 = parseProcNetTable(tcpHeader + tcpRow(0, '0100007F:1F90', '0100007F:D431', '01', '11') + tcpRow(1, '0100007F:0FA0', '00000000:0000', '0A', '12') + tcpRow(2, '0A00000A:D000', '08080808:01BB', '01', '13') + tcpRow(3, '0100007F:0001', '0100007F:0002', '06', '0'), 'tcp', 4)
  assert.deepEqual([...v4.keys()], ['11', '12', '13'])
  assert.deepEqual(v4.get('11').remote, { address: '127.0.0.1', port: 54321 })
  assert.deepEqual(v4.get('13').remote, { address: '8.8.8.8', port: 443 })
  const v6 = parseProcNetTable(tcpHeader + tcpRow(0, '00000000000000000000000001000000:1F90', '0000000000000000FFFF00000100007F:D431', '01', '21'), 'tcp', 6)
  assert.equal(v6.get('21').local.address, '0:0:0:0:0:0:0:1')
  assert.equal(v6.get('21').remote.address, '::ffff:127.0.0.1')
  for (const address of ['127.0.0.1', '127.1.2.3', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(address), true)
  for (const address of ['8.8.8.8', '10.0.0.10', '0.0.0.0', '::ffff:8.8.8.8', '2001:db8:0:0:0:0:0:1']) assert.equal(isLoopbackAddress(address), false)
})

test('observer reports loopback peers, flags a non-loopback peer and keeps listeners apart', async t => {
  const procRoot = path.join(await scratch(t), 'proc')
  await fs.mkdir(path.join(procRoot, 'net'), { recursive: true })
  await fs.writeFile(path.join(procRoot, 'net', 'tcp'), tcpHeader + tcpRow(0, '0100007F:D431', '0100007F:1F90', '01', '31') + tcpRow(1, '0A00000A:D000', '08080808:01BB', '01', '32') + tcpRow(2, '00000000:0FA0', '00000000:0000', '0A', '33') + tcpRow(3, '0100007F:D432', '00000000:0000', '07', '34'))
  await fakeProcess(procRoot, 200, { env: { [RUN_ROOT_MARKER_ENV]: '/p/MagicPot/run' }, comm: 'electron', sockets: ['31', '33', '34'] })
  await fakeProcess(procRoot, 201, { env: { [RUN_ROOT_MARKER_ENV]: '/p/MagicPot/other' }, comm: 'foreign', sockets: ['32'] })
  assert.equal((await sampleLinuxSockets([200], { procRoot })).length, 3)
  const quiet = createLinuxRunObserver({ runRoot: '/p/MagicPot/run', procRoot, sampleMs: 10_000 })
  quiet.start()
  const summary = await quiet.stop()
  assert.deepEqual(summary.endpoints.map(item => [item.kind, item.address, item.port, item.loopback]).sort(), [['listen', '0.0.0.0', 4000, false], ['peer', '127.0.0.1', 8080, true]])
  assert.deepEqual(summary.nonLoopback, [])
  assert.equal(summary.nonLoopbackListeners.length, 1)
  await fakeProcess(procRoot, 202, { env: { [RUN_ROOT_MARKER_ENV]: '/p/MagicPot/run' }, comm: 'leaky', sockets: ['32'] })
  const leaky = createLinuxRunObserver({ runRoot: '/p/MagicPot/run', procRoot, sampleMs: 10_000 })
  leaky.start()
  assert.deepEqual((await leaky.stop()).nonLoopback.map(item => [item.address, item.port, item.comm]), [['8.8.8.8', 443, 'leaky']])
})

test('cleanup signals only owned processes: SIGTERM first, SIGKILL after the grace period', async t => {
  const procRoot = path.join(await scratch(t), 'proc')
  await fakeProcess(procRoot, 300, { env: { [LINUX_OWNER_ENV]: 'mine' }, comm: 'polite' })
  await fakeProcess(procRoot, 301, { env: { [RUN_ROOT_MARKER_ENV]: '/p/MagicPot/run' }, comm: 'stubborn' })
  await fakeProcess(procRoot, 302, { env: { [LINUX_OWNER_ENV]: 'other' }, comm: 'foreign' })
  const signals = []
  const kill = async (pid, signal) => {
    signals.push([pid, signal])
    if (pid === 300 || signal === 'SIGKILL') await fs.rm(path.join(procRoot, String(pid)), { recursive: true, force: true })
  }
  const result = await cleanupOwnedLinuxProcesses({ owner: 'mine', runRoot: '/p/MagicPot/run', procRoot, kill: (pid, signal) => { void kill(pid, signal) }, settleMs: 0, graceMs: 300, pollMs: 20, selfPid: 1 })
  assert.deepEqual(signals.filter(([pid]) => pid === 302), [])
  assert.deepEqual(signals.filter(([, signal]) => signal === 'SIGTERM').map(([pid]) => pid).sort(), [300, 301])
  assert.deepEqual(signals.filter(([, signal]) => signal === 'SIGKILL'), [[301, 'SIGKILL']])
  assert.equal(result.clean, false)
  assert.deepEqual(result.remainingAfter, [])
  assert.deepEqual(result.initiallyAlive.map(item => item.pid).sort(), [300, 301])
  const none = await cleanupOwnedLinuxProcesses({ owner: 'mine', runRoot: '/p/MagicPot/run', procRoot, kill: () => assert.fail('nothing to kill'), settleMs: 0, graceMs: 50, pollMs: 10, selfPid: 1 })
  assert.equal(none.clean, true)
})

test('cleanup waits for processes that exit by themselves before declaring leftovers', async t => {
  const procRoot = path.join(await scratch(t), 'proc')
  await fakeProcess(procRoot, 400, { env: { [LINUX_OWNER_ENV]: 'mine' }, comm: 'Xvfb' })
  setTimeout(() => { void fs.rm(path.join(procRoot, '400'), { recursive: true, force: true }) }, 60)
  const result = await cleanupOwnedLinuxProcesses({ owner: 'mine', procRoot, kill: () => assert.fail('a settling process must not be signalled'), settleMs: 2000, graceMs: 50, pollMs: 20, selfPid: 1 })
  assert.equal(result.clean, true)
})

function fakeXvfb({ code = 0, onSpawn } = {}) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.pid = 999_999
    setImmediate(async () => { await onSpawn?.(options); child.emit('close', code, null) })
    return child
  }
  return { calls, spawn }
}

test('relaunch refuses a used root, a passed worker and non-linux before spawning anything', async t => {
  const used = await freshRoot(t, ['app', 'evidence'])
  const xvfb = fakeXvfb()
  const options = { privateRoot: used.privateRoot, spawn: xvfb.spawn, platform: 'linux', log: () => {} }
  await assert.rejects(relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [used.runRoot], options), /never-run root/)
  const fresh = await freshRoot(t)
  await assert.rejects(relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [fresh.runRoot, '/private/worker.exe'], { ...options, privateRoot: fresh.privateRoot }), /do not pass a worker path/)
  await assert.rejects(relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [fresh.runRoot], { ...options, privateRoot: fresh.privateRoot, platform: 'win32' }), /Linux only/)
  await assert.rejects(relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [], { ...options, privateRoot: fresh.privateRoot }), /new private run root/)
  assert.equal(xvfb.calls.length, 0)
  assert.deepEqual(await fs.readdir(fresh.runRoot), ['app'])
})

test('relaunch runs the runner under xvfb-run in its own group and records the host observation', async t => {
  const { privateRoot, runRoot } = await freshRoot(t)
  const procRoot = path.join(await scratch(t), 'proc')
  await fs.mkdir(procRoot)
  const xvfb = fakeXvfb({ onSpawn: () => fs.mkdir(path.join(runRoot, 'evidence')) })
  const lines = []
  const code = await relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [runRoot], { privateRoot, spawn: xvfb.spawn, procRoot, platform: 'linux', env: { PATH: '/bin' }, execPath: '/node', sampleMs: 20, settleMs: 0, graceMs: 50, kill: () => assert.fail('no process to signal'), log: line => lines.push(line) })
  assert.equal(code, 0)
  assert.equal(xvfb.calls.length, 1)
  const [call] = xvfb.calls
  assert.equal(call.command, 'xvfb-run')
  assert.deepEqual(call.args, ['-a', '-s', '-screen 0 1920x1200x24', '/node', '/repo/runner.mjs', runRoot])
  assert.equal(call.options.detached, true)
  assert.equal(call.options.env[LINUX_XVFB_ENV], '1')
  assert.match(call.options.env[LINUX_OWNER_ENV], /^[0-9a-f-]{36}$/)
  const observation = JSON.parse(await fs.readFile(path.join(runRoot, 'evidence', 'linux-host-observation.json'), 'utf8'))
  assert.equal(observation.status, 'passed')
  assert.equal(observation.ownerToken, call.options.env[LINUX_OWNER_ENV])
  assert.deepEqual(observation.network.nonLoopback, [])
  assert.equal(observation.cleanup.clean, true)
  assert.match(lines.at(-1), /^isolated-linux-host /)
})

test('relaunch fails the run when the runner fails or a process of the run outlives it', async t => {
  const failing = await freshRoot(t)
  const procRoot = path.join(await scratch(t), 'proc')
  await fs.mkdir(procRoot)
  const quiet = { procRoot, platform: 'linux', env: {}, execPath: '/node', sampleMs: 20, settleMs: 0, graceMs: 50, log: () => {} }
  assert.equal(await relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [failing.runRoot], { ...quiet, privateRoot: failing.privateRoot, spawn: fakeXvfb({ code: 1 }).spawn, kill: () => assert.fail('nothing owned') }), 1)
  const leaking = await freshRoot(t)
  const signals = []
  const xvfb = fakeXvfb({ onSpawn: options => fakeProcess(procRoot, 500, { env: { [LINUX_OWNER_ENV]: options.env[LINUX_OWNER_ENV] }, comm: 'electron' }) })
  const kill = (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGKILL') void fs.rm(path.join(procRoot, String(pid)), { recursive: true, force: true }) }
  assert.equal(await relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [leaking.runRoot], { ...quiet, privateRoot: leaking.privateRoot, spawn: xvfb.spawn, kill }), 1)
  assert.deepEqual(signals, [[500, 'SIGTERM'], [500, 'SIGKILL']])
})
