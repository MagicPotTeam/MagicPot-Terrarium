// Fake platforms, fake /proc trees and fake spawn: no Electron, no cargo, no display, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LINUX_OWNER_ENV, LINUX_XVFB_ENV, LINUX_WRAPPER_ENV, RUN_ROOT_MARKER_ENV,
  isolatedWorkerPath, isolatedWorkerSourceArgument, isolatedElectronArgs, linuxIsolatedEnvironment,
  assertFreshIsolatedRunRoot, buildLinuxIsolatedWorker, needsLinuxXvfbRelaunch, linuxXvfbCommand,
  listOwnedLinuxProcesses, parseProcNetTable, isLoopbackAddress, sampleLinuxSockets, createLinuxRunObserver,
  cleanupOwnedLinuxProcesses, relaunchIsolatedRunnerUnderXvfb, createLinuxOwnershipTracker, parseStat, armLinuxWrapperWatchdog
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

// stat carries the real field layout up to starttime (field 22). `clobbered` mimics Chromium's
// setproctitle, which overwrites the environ area of the zygote, GPU, renderer and utility children.
const statLine = (pid, comm, ppid, pgid, starttime) => `${pid} (${comm}) S ${ppid} ${pgid} ${pgid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 1000 100`
async function fakeProcess(procRoot, pid, { env = {}, clobbered = false, comm = 'proc', ppid = 1, pgid = pid, starttime = 1000, sockets = [] } = {}) {
  const dir = path.join(procRoot, String(pid))
  await fs.mkdir(path.join(dir, 'fd'), { recursive: true })
  await fs.writeFile(path.join(dir, 'environ'), clobbered ? '||||||||' : Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\0') + '\0')
  await fs.writeFile(path.join(dir, 'stat'), statLine(pid, comm, ppid, pgid, starttime))
  for (const [index, inode] of sockets.entries()) await fs.symlink(`socket:[${inode}]`, path.join(dir, 'fd', String(index + 3)))
  return dir
}
const restat = (procRoot, pid, { comm = 'proc', ppid = 1, pgid = pid, starttime = 1000 } = {}) => fs.writeFile(path.join(procRoot, String(pid), 'stat'), statLine(pid, comm, ppid, pgid, starttime))

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
  assert.throws(() => isolatedWorkerSourceArgument('/hidden/worker.exe', 'linux'), /built from packages\/canvas-thumbnail-sidecar/)
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
  // A stale wrapper identity from the caller is never forwarded; only this wrapper's own.
  assert.equal(Object.hasOwn(linuxXvfbCommand({ script: '/s', args: [], env: { [LINUX_WRAPPER_ENV]: '1:1' }, owner: 'o' }).env, LINUX_WRAPPER_ENV), false)
  assert.equal(linuxXvfbCommand({ script: '/s', args: [], env: { [LINUX_WRAPPER_ENV]: '1:1' }, owner: 'o', wrapper: '42:777' }).env[LINUX_WRAPPER_ENV], '42:777')
})

test('linux environment forwards this run owner token to Electron, and nothing else from the host', () => {
  const env = linuxIsolatedEnvironment('/p/MagicPot/run', { DISPLAY: ':99', [LINUX_OWNER_ENV]: 'tok', [LINUX_WRAPPER_ENV]: '1:2', [LINUX_XVFB_ENV]: '1' })
  assert.equal(env[LINUX_OWNER_ENV], 'tok')
  assert.equal(Object.hasOwn(env, LINUX_WRAPPER_ENV), false)
  assert.equal(Object.hasOwn(env, LINUX_XVFB_ENV), false)
  assert.equal(Object.hasOwn(linuxIsolatedEnvironment('/p/MagicPot/run', {}), LINUX_OWNER_ENV), false)
})

test('stat parsing reads ppid, pgid and starttime even when comm holds spaces and parentheses', () => {
  assert.deepEqual(parseStat(statLine(7, 'a (b) c', 3, 5, 123456)), { comm: 'a (b) c', ppid: 3, pgid: 5, starttime: 123456 })
  assert.equal(parseStat('7 (x) S 1 7 7').starttime, null)
  assert.equal(parseStat(''), null)
})

// The shape of a real run: xvfb-run (group 100, detached by the wrapper) -> node runner ->
// Electron (Playwright detaches it: own group 120, owner token) -> Chromium children with a
// clobbered environ in Electron's group, the zygote's renderer one level further down.
async function fakeRun(procRoot, { owner = 'mine', base = 100 } = {}) {
  const pid = offset => base + offset
  await fakeProcess(procRoot, pid(0), { env: { [LINUX_OWNER_ENV]: owner }, comm: 'xvfb-run', ppid: 50, starttime: 1000 })
  await fakeProcess(procRoot, pid(1), { env: { [LINUX_OWNER_ENV]: owner }, comm: 'Xvfb', ppid: pid(0), pgid: pid(0), starttime: 1001 })
  await fakeProcess(procRoot, pid(2), { env: { [LINUX_OWNER_ENV]: owner }, comm: 'node', ppid: pid(0), pgid: pid(0), starttime: 1002 })
  await fakeProcess(procRoot, pid(20), { env: { [LINUX_OWNER_ENV]: owner, [RUN_ROOT_MARKER_ENV]: '/p/MagicPot/run' }, comm: 'electron', ppid: pid(2), starttime: 1100 })
  await fakeProcess(procRoot, pid(21), { clobbered: true, comm: 'electron', ppid: pid(20), pgid: pid(20), starttime: 1101 }) // zygote
  await fakeProcess(procRoot, pid(22), { clobbered: true, comm: 'electron', ppid: pid(21), pgid: pid(20), starttime: 1102 }) // renderer
  await fakeProcess(procRoot, pid(23), { clobbered: true, comm: 'electron', ppid: pid(20), pgid: pid(20), starttime: 1103 }) // network service
  return { group: pid(0), electron: pid(20), zygote: pid(21), renderer: pid(22), network: pid(23) }
}

test('ownership covers the run group, every descendant and Electron\'s group even with a clobbered environ', async t => {
  const procRoot = path.join(await scratch(t), 'proc')
  const run = await fakeRun(procRoot)
  await fakeProcess(procRoot, 50, { env: { [LINUX_OWNER_ENV]: 'mine' }, comm: 'wrapper', starttime: 900 }) // self
  await fakeProcess(procRoot, 300, { env: { [LINUX_OWNER_ENV]: 'other' }, comm: 'foreign' })
  await fakeProcess(procRoot, 301, { env: { NOTE: `${LINUX_OWNER_ENV}=mine` }, comm: 'lookalike' })
  // Another run on the SAME root: it shares the run-root marker but not the token or group.
  await fakeProcess(procRoot, 310, { env: { [LINUX_OWNER_ENV]: 'theirs', [RUN_ROOT_MARKER_ENV]: '/p/MagicPot/run' }, comm: 'electron', ppid: 309, starttime: 1200 })
  await fakeProcess(procRoot, 311, { clobbered: true, comm: 'electron', ppid: 310, pgid: 310, starttime: 1201 })
  // A foreign process that claims the run group but is older than its leader (never a member).
  await fakeProcess(procRoot, 320, { clobbered: true, comm: 'old', ppid: 1, pgid: run.group, starttime: 10 })
  const owned = await listOwnedLinuxProcesses({ owner: 'mine', group: run.group, procRoot, selfPid: 50 })
  assert.deepEqual(owned.map(item => item.pid).sort((a, b) => a - b), [100, 101, 102, 120, 121, 122, 123])
  assert.equal(owned.find(item => item.pid === run.network).via !== undefined, true)
  // The group alone (no token): Electron is still found through ancestry.
  const byGroup = await listOwnedLinuxProcesses({ group: run.group, procRoot, selfPid: 50 })
  assert.deepEqual(byGroup.map(item => item.pid).sort((a, b) => a - b), [100, 101, 102, 120, 121, 122, 123])
  // The token alone (no group): Chromium children are found through Electron's group and ancestry.
  const byToken = await listOwnedLinuxProcesses({ owner: 'mine', procRoot, selfPid: 50 })
  assert.deepEqual(byToken.map(item => item.pid).sort((a, b) => a - b), [100, 101, 102, 120, 121, 122, 123])
})

test('ownership is pinned by start time: an orphan stays owned, a reused pid does not', async t => {
  const procRoot = path.join(await scratch(t), 'proc')
  const run = await fakeRun(procRoot)
  const tracker = createLinuxOwnershipTracker({ owner: 'mine', group: run.group, procRoot, selfPid: 1 })
  assert.equal((await tracker.scan()).length, 7)
  // The runner, Electron and the zygote die; the renderer is reparented to init but keeps its
  // group, the network service is reparented and moved to a new group of its own.
  for (const pid of [102, run.electron, run.zygote]) await fs.rm(path.join(procRoot, String(pid)), { recursive: true })
  await restat(procRoot, run.renderer, { comm: 'electron', ppid: 1, pgid: run.electron, starttime: 1102 })
  await restat(procRoot, run.network, { comm: 'electron', ppid: 1, pgid: run.network, starttime: 1103 })
  assert.deepEqual((await tracker.scan()).map(item => item.pid).sort((a, b) => a - b), [100, 101, run.renderer, run.network])
  // The network service's pid is reused by a foreign process: not owned, and isSameProcess fails.
  const stale = { pid: run.network, starttime: 1103 }
  await fs.rm(path.join(procRoot, String(run.network)), { recursive: true })
  await fakeProcess(procRoot, run.network, { env: { HOME: '/root' }, comm: 'foreign', ppid: 1, starttime: 5000 })
  assert.deepEqual((await tracker.scan()).map(item => item.pid).sort((a, b) => a - b), [100, 101, run.renderer])
  assert.equal(await tracker.isSameProcess(stale), false)
  assert.equal(await tracker.isSameProcess({ pid: run.renderer, starttime: 1102 }), true)
  // Electron's group number is taken by a new foreign leader: its members are not owned.
  await fakeProcess(procRoot, run.electron, { env: {}, comm: 'foreign-leader', ppid: 1, starttime: 6000 })
  await fakeProcess(procRoot, 200, { env: {}, comm: 'foreign-member', ppid: run.electron, pgid: run.electron, starttime: 6001 })
  assert.deepEqual((await tracker.scan()).map(item => item.pid).sort((a, b) => a - b), [100, 101, run.renderer])
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
  await fakeProcess(procRoot, 200, { env: { [LINUX_OWNER_ENV]: 'mine' }, comm: 'electron', sockets: ['31', '33', '34'] })
  await fakeProcess(procRoot, 201, { env: { [LINUX_OWNER_ENV]: 'other', [RUN_ROOT_MARKER_ENV]: '/p/MagicPot/run' }, comm: 'foreign', sockets: ['32'] })
  assert.equal((await sampleLinuxSockets([200], { procRoot })).length, 3)
  const quiet = createLinuxRunObserver({ owner: 'mine', procRoot, sampleMs: 10_000, selfPid: 1 })
  quiet.start()
  const summary = await quiet.stop()
  assert.deepEqual(summary.endpoints.map(item => [item.kind, item.address, item.port, item.loopback]).sort(), [['listen', '0.0.0.0', 4000, false], ['peer', '127.0.0.1', 8080, true]])
  assert.deepEqual(summary.nonLoopback, [])
  assert.equal(summary.nonLoopbackListeners.length, 1)
  // A Chromium child with a clobbered environ (Electron's group, ppid Electron) is observed too.
  await fakeProcess(procRoot, 202, { clobbered: true, comm: 'leaky', ppid: 200, pgid: 200, starttime: 1001, sockets: ['32'] })
  const leaky = createLinuxRunObserver({ owner: 'mine', procRoot, sampleMs: 10_000, selfPid: 1 })
  leaky.start()
  assert.deepEqual((await leaky.stop()).nonLoopback.map(item => [item.address, item.port, item.comm]), [['8.8.8.8', 443, 'leaky']])
})

test('observer sees the network-service socket to the loopback mock in a real-shaped run', async t => {
  const procRoot = path.join(await scratch(t), 'proc')
  await fs.mkdir(path.join(procRoot, 'net'), { recursive: true })
  // 127.0.0.1:55654 -> 127.0.0.1:43197 (the mock), held only by the network service.
  await fs.writeFile(path.join(procRoot, 'net', 'tcp'), tcpHeader + tcpRow(0, '0100007F:D9A6', '0100007F:A8BD', '01', '41'))
  const run = await fakeRun(procRoot)
  await fs.symlink('socket:[41]', path.join(procRoot, String(run.network), 'fd', '3'))
  const observer = createLinuxRunObserver({ owner: 'mine', group: run.group, procRoot, sampleMs: 10_000, selfPid: 1 })
  observer.start()
  const summary = await observer.stop()
  assert.deepEqual(summary.endpoints.map(item => [item.kind, item.address, item.port, item.loopback]), [['peer', '127.0.0.1', 43197, true]])
  assert.equal(summary.processes.length, 7)
})

test('cleanup signals only owned processes: SIGTERM first, SIGKILL after the grace period', async t => {
  const procRoot = path.join(await scratch(t), 'proc')
  await fakeProcess(procRoot, 300, { env: { [LINUX_OWNER_ENV]: 'mine' }, comm: 'polite' })
  await fakeProcess(procRoot, 301, { clobbered: true, comm: 'stubborn', ppid: 300, pgid: 300, starttime: 1001 }) // Chromium child
  await fakeProcess(procRoot, 302, { env: { [LINUX_OWNER_ENV]: 'other' }, comm: 'foreign' })
  // Same root, other run: shares the run-root marker only (should-fix: never signalled).
  await fakeProcess(procRoot, 303, { env: { [RUN_ROOT_MARKER_ENV]: '/p/MagicPot/run' }, comm: 'other-run' })
  const signals = []
  // The fake process exits synchronously with the signal, as a real kill() is observed by the next scan.
  const kill = (pid, signal) => {
    signals.push([pid, signal])
    if (pid === 300 || signal === 'SIGKILL') rmSync(path.join(procRoot, String(pid)), { recursive: true, force: true })
  }
  const result = await cleanupOwnedLinuxProcesses({ owner: 'mine', procRoot, kill, settleMs: 0, graceMs: 300, pollMs: 20, selfPid: 1 })
  assert.deepEqual(signals.filter(([pid]) => pid === 302 || pid === 303), [])
  assert.deepEqual(signals.filter(([, signal]) => signal === 'SIGTERM').map(([pid]) => pid).sort(), [300, 301])
  assert.deepEqual(signals.filter(([, signal]) => signal === 'SIGKILL'), [[301, 'SIGKILL']])
  assert.equal(result.clean, false)
  assert.deepEqual(result.remainingAfter, [])
  assert.deepEqual(result.initiallyAlive.map(item => item.pid).sort(), [300, 301])
  const none = await cleanupOwnedLinuxProcesses({ owner: 'mine', procRoot, kill: () => assert.fail('nothing to kill'), settleMs: 0, graceMs: 50, pollMs: 10, selfPid: 1 })
  assert.equal(none.clean, true)
})

test('cleanup never signals a pid whose start time changed after it was listed', async () => {
  const listed = { pid: 700, starttime: 5, comm: 'electron' }
  const tracker = { scan: async () => [listed], isSameProcess: async item => { assert.equal(item, listed); return false } }
  const signals = [] // cleanup swallows kill() errors, so record instead of throwing
  const result = await cleanupOwnedLinuxProcesses({ tracker, kill: (pid, signal) => signals.push([pid, signal]), settleMs: 0, graceMs: 60, pollMs: 10 })
  assert.deepEqual(signals, [])
  assert.deepEqual([result.terminated, result.killed], [[], []])
  assert.equal(result.clean, false)
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

test('relaunch forwards only the flags the runner accepts', async t => {
  const fresh = await freshRoot(t)
  const xvfb = fakeXvfb()
  const options = { privateRoot: fresh.privateRoot, spawn: xvfb.spawn, platform: 'linux', log: () => {} }
  await assert.rejects(relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [fresh.runRoot, '--no-crash-recovery'], options), /Unknown option\(s\) for this runner: --no-crash-recovery \(it takes none\)/)
  await assert.rejects(relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [fresh.runRoot, '--verbose'], { ...options, allowedFlags: ['--no-crash-recovery'] }), /Unknown option\(s\).*--verbose.*accepted: --no-crash-recovery/)
  assert.equal(xvfb.calls.length, 0)
  assert.deepEqual(await fs.readdir(fresh.runRoot), ['app'])
})

test('relaunch refuses a used root, a passed worker and non-linux before spawning anything', async t => {
  const used = await freshRoot(t, ['app', 'evidence'])
  const xvfb = fakeXvfb()
  const options = { privateRoot: used.privateRoot, spawn: xvfb.spawn, platform: 'linux', log: () => {} }
  await assert.rejects(relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [used.runRoot], options), /never-run root/)
  const fresh = await freshRoot(t)
  await assert.rejects(relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [fresh.runRoot, '/hidden/worker.exe'], { ...options, privateRoot: fresh.privateRoot }), /do not pass a worker path/)
  await assert.rejects(relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [fresh.runRoot], { ...options, privateRoot: fresh.privateRoot, platform: 'win32' }), /Linux only/)
  await assert.rejects(relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [fresh.runRoot, '--no-crash-recovery', '/hidden/worker.exe'], { ...options, privateRoot: fresh.privateRoot }), /do not pass a worker path/)
  await assert.rejects(relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [], { ...options, privateRoot: fresh.privateRoot }), /new private run root/)
  await assert.rejects(relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', ['--no-crash-recovery'], { ...options, privateRoot: fresh.privateRoot }), /new private run root/)
  assert.equal(xvfb.calls.length, 0)
  assert.deepEqual(await fs.readdir(fresh.runRoot), ['app'])
})

test('relaunch runs the runner under xvfb-run in its own group and records the host observation', async t => {
  const { privateRoot, runRoot } = await freshRoot(t)
  const procRoot = path.join(await scratch(t), 'proc')
  await fs.mkdir(procRoot)
  const xvfb = fakeXvfb({ onSpawn: () => fs.mkdir(path.join(runRoot, 'evidence')) })
  const lines = []
  await fakeProcess(procRoot, 4242, { env: {}, comm: 'node', starttime: 777 }) // the wrapper itself
  const code = await relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [runRoot, '--no-crash-recovery'], { privateRoot, allowedFlags: ['--no-crash-recovery'], spawn: xvfb.spawn, procRoot, platform: 'linux', env: { PATH: '/bin' }, execPath: '/node', sampleMs: 20, settleMs: 0, graceMs: 50, selfPid: 4242, kill: () => assert.fail('no process to signal'), log: line => lines.push(line) })
  assert.equal(code, 0)
  assert.equal(xvfb.calls.length, 1)
  const [call] = xvfb.calls
  assert.equal(call.command, 'xvfb-run')
  assert.deepEqual(call.args, ['-a', '-s', '-screen 0 1920x1200x24', '/node', '/repo/runner.mjs', runRoot, '--no-crash-recovery'])
  assert.equal(call.options.detached, true)
  assert.equal(call.options.env[LINUX_XVFB_ENV], '1')
  assert.match(call.options.env[LINUX_OWNER_ENV], /^[0-9a-f-]{36}$/)
  assert.equal(call.options.env[LINUX_WRAPPER_ENV], '4242:777')
  const observation = JSON.parse(await fs.readFile(path.join(runRoot, 'evidence', 'linux-host-observation.json'), 'utf8'))
  assert.equal(observation.status, 'passed')
  assert.equal(observation.ownerToken, call.options.env[LINUX_OWNER_ENV])
  assert.equal(observation.processGroup, 999_999)
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
  const kill = (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGKILL') rmSync(path.join(procRoot, String(pid)), { recursive: true, force: true }) }
  assert.equal(await relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [leaking.runRoot], { ...quiet, privateRoot: leaking.privateRoot, spawn: xvfb.spawn, kill }), 1)
  assert.deepEqual(signals, [[500, 'SIGTERM'], [500, 'SIGKILL']])
  // A leftover in the run's process group with a clobbered environ (no token) is found and signalled.
  const grouped = await freshRoot(t)
  const groupSignals = []
  const groupXvfb = fakeXvfb({ onSpawn: () => fakeProcess(procRoot, 600, { clobbered: true, comm: 'electron', ppid: 1, pgid: 999_999, starttime: 2000 }) })
  const groupKill = (pid, signal) => { groupSignals.push([pid, signal]); if (signal === 'SIGKILL') rmSync(path.join(procRoot, String(pid)), { recursive: true, force: true }) }
  assert.equal(await relaunchIsolatedRunnerUnderXvfb('/repo/runner.mjs', [grouped.runRoot], { ...quiet, privateRoot: grouped.privateRoot, spawn: groupXvfb.spawn, kill: groupKill }), 1)
  assert.deepEqual(groupSignals, [[600, 'SIGTERM'], [600, 'SIGKILL']])
})

test('wrapper watchdog: armed only inside the linux relaunch, stops the run group once the wrapper is gone', async t => {
  const procRoot = path.join(await scratch(t), 'proc')
  const inside = { [LINUX_XVFB_ENV]: '1', [LINUX_OWNER_ENV]: 'mine', [LINUX_WRAPPER_ENV]: '50:900' }
  assert.equal(armLinuxWrapperWatchdog({ env: inside, platform: 'win32', procRoot }), null)
  assert.equal(armLinuxWrapperWatchdog({ env: { ...inside, [LINUX_XVFB_ENV]: undefined }, platform: 'linux', procRoot }), null)
  assert.equal(armLinuxWrapperWatchdog({ env: { ...inside, [LINUX_WRAPPER_ENV]: undefined }, platform: 'linux', procRoot }), null)
  await fakeProcess(procRoot, 50, { env: {}, comm: 'node', starttime: 900 }) // wrapper
  await fakeProcess(procRoot, 100, { env: { [LINUX_OWNER_ENV]: 'mine' }, comm: 'xvfb-run', ppid: 50, starttime: 1000 }) // run group leader
  await fakeProcess(procRoot, 102, { env: { [LINUX_OWNER_ENV]: 'mine' }, comm: 'node', ppid: 100, pgid: 100, starttime: 1002 }) // this runner
  const signals = [], exits = []
  const options = { env: inside, platform: 'linux', procRoot, selfPid: 102, intervalMs: 60_000, graceMs: 10, kill: (pid, signal) => signals.push([pid, signal]), exit: code => exits.push(code), log: () => {} }
  const watchdog = armLinuxWrapperWatchdog(options)
  t.after(() => watchdog.stop())
  assert.equal(await watchdog.check(), false)
  // The wrapper's pid is reused by another process (different start time): treated as gone.
  await restat(procRoot, 50, { comm: 'other', starttime: 5000 })
  assert.equal(await watchdog.check(), true)
  assert.deepEqual(signals, [[-100, 'SIGTERM']])
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(exits, [1])
  assert.equal(await watchdog.check(), false) // fires once
  // A group leader without this run's token is never signalled as a group: only the runner itself.
  await fs.writeFile(path.join(procRoot, '100', 'environ'), `${LINUX_OWNER_ENV}=other\0`)
  const lone = armLinuxWrapperWatchdog({ ...options, kill: (pid, signal) => signals.push([pid, signal]) })
  t.after(() => lone.stop())
  assert.equal(await lone.check(), true)
  assert.deepEqual(signals.at(-1), [102, 'SIGTERM'])
})
