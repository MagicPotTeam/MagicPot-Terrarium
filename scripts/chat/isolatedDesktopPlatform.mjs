// Platform switch for the isolated desktop runners (scripts/chat/isolated*.mjs).
//
// Windows keeps the original behaviour: the caller passes a private Windows image
// worker, which is copied to <root>/bin/canvas-thumbnail-sidecar.exe, and Electron is
// launched directly. Every helper below returns the original value for win32.
//
// Linux (test containers and developer machines, never a personal profile):
// - the image worker is built from packages/canvas-thumbnail-sidecar with
//   `cargo build --locked --release` into <root>/worker-target and copied to
//   <root>/bin/canvas-thumbnail-sidecar; no worker path is accepted from the caller;
// - the runner re-executes itself under `xvfb-run` (no real display), in its own
//   process group, with an owner token in the environment;
// - after the run, only processes that carry this run's owner token or this run's
//   private root marker are terminated; nothing else is signalled;
// - while the run is alive, the TCP/UDP endpoints of those processes are sampled from
//   /proc so the report can show that only loopback addresses were contacted.
// The bootstrap gates (isolatedImageDesktopBootstrap.cjs) are unchanged on both platforms.
import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { getImageWorkerBuildPaths } from '../build-image-worker.mjs'

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Set by the xvfb relaunch; the runner body only runs on Linux when it is present. */
export const LINUX_XVFB_ENV = 'MAGICPOT_ISOLATED_LINUX_XVFB'
/** Unique per relaunch; every process started for the run inherits it. */
export const LINUX_OWNER_ENV = 'MAGICPOT_ISOLATED_LINUX_OWNER'
/** Set by isolatedImageEnvironment for Electron and all of its children. */
export const RUN_ROOT_MARKER_ENV = 'MAGICPOT_TEST_ARTIFACT_ROOT'
export const LINUX_XVFB_SCREEN = '-screen 0 1920x1200x24'
export const LINUX_WORKER_FILE = 'canvas-thumbnail-sidecar'

export const isLinuxIsolatedPlatform = (platform = process.platform) => platform === 'linux'

/** Where the bootstrap expects the image worker inside the run root. */
export function isolatedWorkerPath(runRoot, platform = process.platform) {
  if (isLinuxIsolatedPlatform(platform)) return path.join(runRoot, 'bin', LINUX_WORKER_FILE)
  return path.join(runRoot, 'bin/canvas-thumbnail-sidecar.exe')
}

/** CLI worker argument: Windows resolves it as before; Linux builds the worker and accepts none. */
export function isolatedWorkerSourceArgument(value, platform = process.platform) {
  if (!isLinuxIsolatedPlatform(platform)) return path.resolve(value)
  assertNoLinuxWorkerSource(value)
  return undefined
}

export function assertNoLinuxWorkerSource(workerSource) {
  if (workerSource !== undefined) {
    throw new Error('On Linux the image worker is built from packages/canvas-thumbnail-sidecar into the run root; do not pass a worker path.')
  }
}

/** Linux-only Electron switches. The container runs as root, where Chromium refuses its sandbox. */
export function isolatedElectronArgs(args, platform = process.platform) {
  if (!isLinuxIsolatedPlatform(platform)) return args
  return [...args, '--no-sandbox']
}

/**
 * Linux additions to the isolated Electron environment: a private HOME/XDG/TMPDIR inside
 * the run root, the Chinese UI the fixtures select by label, the xvfb display, and the
 * standing test flags. Nothing from the host is copied except DISPLAY and XAUTHORITY.
 */
export function linuxIsolatedEnvironment(runRoot, hostEnv = process.env) {
  const home = path.join(runRoot, 'home')
  const environment = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    TMPDIR: path.join(runRoot, 'temp'),
    LANG: 'zh_CN.UTF-8',
    MAGICPOT_PRIVATE_TEST_SKIP_LEGACY_USER_DATA_MIGRATION: '1',
    MAGICPOT_PRIVATE_LIVE_SYNC: '0'
  }
  if (hostEnv.DISPLAY) environment.DISPLAY = hostEnv.DISPLAY
  if (hostEnv.XAUTHORITY) environment.XAUTHORITY = hostEnv.XAUTHORITY
  return environment
}

/**
 * A Linux run root must be <privateRoot>/MagicPot/<runId>, canonical, and contain only the
 * freshly built app/ directory. A root that was ever used (any other entry) is refused, so a
 * failed or unknown run is never replayed on the same root.
 */
export async function assertFreshIsolatedRunRoot(runRoot, privateRoot) {
  assert(typeof runRoot === 'string' && path.isAbsolute(runRoot), 'Use an absolute new private run root')
  assert(typeof privateRoot === 'string' && path.isAbsolute(privateRoot), 'Private root required')
  assert.equal(path.dirname(path.resolve(runRoot)), path.join(path.resolve(privateRoot), 'MagicPot'), 'The run root must be <private root>/MagicPot/<run id>')
  assert(/^[A-Za-z0-9_-]+$/.test(path.basename(runRoot)), 'The run id must use letters, digits, "-" or "_"')
  assert.equal(await fs.realpath(runRoot), path.resolve(runRoot), 'The run root must be canonical')
  assert.deepEqual((await fs.readdir(runRoot)).sort(), ['app'], 'Use a freshly built, never-run root (only app/ may exist)')
  const app = await fs.lstat(path.join(runRoot, 'app'))
  assert(app.isDirectory() && !app.isSymbolicLink(), 'The built app directory must be owned by this root')
}

/**
 * Builds the image worker from source for Linux into <runRoot>/worker-target and copies it
 * to <runRoot>/bin/canvas-thumbnail-sidecar (which must not exist yet). The caller creates
 * <runRoot>/bin first. Uses the manifest that scripts/build-image-worker.mjs builds.
 */
export async function buildLinuxIsolatedWorker(runRoot, { repoRoot = defaultRepoRoot, platform = process.platform, spawn = spawnChild, env = process.env, timeoutMs = 15 * 60_000 } = {}) {
  assert(isLinuxIsolatedPlatform(platform), 'The source-built image worker is only used on Linux')
  const { manifestPath } = getImageWorkerBuildPaths({ repoRoot, platform: 'linux' })
  await fs.access(manifestPath)
  await fs.access(path.join(path.dirname(manifestPath), 'Cargo.lock'))
  const targetDir = path.join(runRoot, 'worker-target')
  await fs.mkdir(targetDir) // Refuses an existing target: a root is never reused.
  const logPath = path.join(targetDir, 'cargo-build.log')
  const args = ['build', '--locked', '--release', '--manifest-path', manifestPath]
  const log = await fs.open(logPath, 'wx')
  let result
  try {
    const child = spawn('cargo', args, { cwd: path.dirname(manifestPath), env: { ...env, CARGO_TARGET_DIR: targetDir }, stdio: ['ignore', log.fd, log.fd], shell: false })
    result = await new Promise(resolve => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } resolve({ code: null, signal: 'timeout' }) }, timeoutMs)
      child.once('error', error => { clearTimeout(timer); resolve({ code: null, signal: null, error: error.message }) })
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    })
  } finally { await log.close() }
  if (result.code !== 0) throw new Error(`cargo build --locked of the image worker failed (${result.error ?? result.signal ?? 'exit ' + result.code}); see ${logPath}`)
  const builtPath = path.join(targetDir, 'release', LINUX_WORKER_FILE)
  const built = await fs.lstat(builtPath)
  assert(built.isFile() && !built.isSymbolicLink(), 'cargo did not produce a regular worker binary')
  const workerPath = isolatedWorkerPath(runRoot, 'linux')
  await fs.copyFile(builtPath, workerPath, constants.COPYFILE_EXCL)
  await fs.chmod(workerPath, 0o755)
  const bytes = await fs.readFile(workerPath)
  return { workerPath, manifestPath, targetDir, logPath, command: ['cargo', ...args], bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Decides whether a runner CLI must re-execute itself under xvfb-run (Linux, not yet inside). */
export function needsLinuxXvfbRelaunch(platform = process.platform, env = process.env) {
  return isLinuxIsolatedPlatform(platform) && env[LINUX_XVFB_ENV] !== '1'
}

export function linuxXvfbCommand({ script, args, execPath = process.execPath, env = process.env, owner }) {
  return {
    command: 'xvfb-run',
    args: ['-a', '-s', LINUX_XVFB_SCREEN, execPath, script, ...args],
    env: { ...env, [LINUX_XVFB_ENV]: '1', [LINUX_OWNER_ENV]: owner }
  }
}

// ---- /proc helpers (Linux only; procRoot is injectable for tests) --------------------------

async function readText(file) {
  try { return await fs.readFile(file, 'utf8') } catch { return null }
}

function parseStat(text) {
  if (!text) return null
  const close = text.lastIndexOf(')')
  const open = text.indexOf('(')
  if (open < 0 || close < open) return null
  const fields = text.slice(close + 2).split(' ')
  return { comm: text.slice(open + 1, close), ppid: Number(fields[1]), pgid: Number(fields[2]) }
}

/**
 * Processes owned by this run: their environment carries the owner token of this relaunch
 * or the private run-root marker that only this run's Electron tree receives.
 */
export async function listOwnedLinuxProcesses({ owner, runRoot, procRoot = '/proc', selfPid = process.pid }) {
  const needles = []
  if (owner) needles.push(`${LINUX_OWNER_ENV}=${owner}`)
  if (runRoot) needles.push(`${RUN_ROOT_MARKER_ENV}=${runRoot}`)
  assert(needles.length > 0, 'An owner token or run root is required')
  let entries = []
  try { entries = await fs.readdir(procRoot) } catch { return [] }
  const owned = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === selfPid) continue
    const environ = await readText(path.join(procRoot, entry, 'environ'))
    if (!environ) continue
    const variables = environ.split('\0')
    if (!needles.some(needle => variables.includes(needle))) continue
    const stat = parseStat(await readText(path.join(procRoot, entry, 'stat')))
    owned.push({ pid: Number(entry), comm: stat?.comm ?? null, ppid: stat?.ppid ?? null, pgid: stat?.pgid ?? null })
  }
  return owned
}

function decodeIpv4(hex) {
  const value = Number.parseInt(hex, 16)
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255].join('.')
}

function decodeIpv6(hex) {
  const bytes = []
  for (let word = 0; word < 4; word++) {
    const chunk = hex.slice(word * 8, word * 8 + 8)
    for (let index = 3; index >= 0; index--) bytes.push(Number.parseInt(chunk.slice(index * 2, index * 2 + 2), 16))
  }
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 255 && bytes[11] === 255) return '::ffff:' + bytes.slice(12).join('.')
  const groups = []
  for (let index = 0; index < 16; index += 2) groups.push(((bytes[index] << 8) | bytes[index + 1]).toString(16))
  return groups.join(':') // Uncompressed on purpose: compared as text below.
}

function decodeEndpoint(value, family) {
  const [hex, port] = value.split(':')
  return { address: family === 6 ? decodeIpv6(hex) : decodeIpv4(hex), port: Number.parseInt(port, 16) }
}

export function isLoopbackAddress(address) {
  return /^127\./.test(address) || address === '0:0:0:0:0:0:0:1' || /^::ffff:127\./.test(address)
}
const isUnspecified = address => address === '0.0.0.0' || address === '0:0:0:0:0:0:0:0'

/** Parses /proc/net/{tcp,tcp6,udp,udp6} into inode -> endpoints. */
export function parseProcNetTable(text, protocol, family) {
  const sockets = new Map()
  for (const line of (text ?? '').split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) continue
    const inode = fields[9]
    if (!/^\d+$/.test(inode) || inode === '0') continue
    sockets.set(inode, { protocol, local: decodeEndpoint(fields[1], family), remote: decodeEndpoint(fields[2], family), state: fields[3] })
  }
  return sockets
}

/** One sample of the network endpoints held by the given processes. */
export async function sampleLinuxSockets(pids, { procRoot = '/proc' } = {}) {
  const tables = new Map()
  for (const [name, protocol, family] of [['tcp', 'tcp', 4], ['tcp6', 'tcp', 6], ['udp', 'udp', 4], ['udp6', 'udp', 6]]) {
    for (const [inode, socket] of parseProcNetTable(await readText(path.join(procRoot, 'net', name)), protocol, family)) tables.set(inode, socket)
  }
  const seen = []
  for (const pid of pids) {
    let fds = []
    try { fds = await fs.readdir(path.join(procRoot, String(pid), 'fd')) } catch { continue }
    for (const fd of fds) {
      let target
      try { target = await fs.readlink(path.join(procRoot, String(pid), 'fd', fd)) } catch { continue }
      const match = /^socket:\[(\d+)\]$/.exec(target)
      const socket = match && tables.get(match[1])
      if (socket) seen.push({ pid, ...socket })
    }
  }
  return seen
}

/** Keeps a bounded summary of owned processes and their endpoints while the run is alive. */
export function createLinuxRunObserver({ owner, runRoot, procRoot = '/proc', sampleMs = 500, selfPid = process.pid }) {
  const processes = new Map()
  const endpoints = new Map()
  let samples = 0, timer, pending, stopped = false
  const collect = async () => {
    const owned = await listOwnedLinuxProcesses({ owner, runRoot, procRoot, selfPid })
    for (const item of owned) if (!processes.has(item.pid) && processes.size < 512) processes.set(item.pid, item)
    for (const socket of await sampleLinuxSockets(owned.map(item => item.pid), { procRoot })) {
      const listening = socket.protocol === 'tcp' ? socket.state === '0A' : socket.remote.port === 0
      const peer = listening ? socket.local : socket.remote
      if (!listening && isUnspecified(peer.address) && peer.port === 0) continue
      const key = `${socket.protocol} ${listening ? 'listen' : 'peer'} ${peer.address}:${peer.port}`
      if (!endpoints.has(key) && endpoints.size < 512) {
        endpoints.set(key, { protocol: socket.protocol, kind: listening ? 'listen' : 'peer', address: peer.address, port: peer.port, loopback: isLoopbackAddress(peer.address), comm: processes.get(socket.pid)?.comm ?? null })
      }
    }
    samples++
  }
  const tick = () => {
    if (stopped || pending) return
    pending = collect().catch(() => undefined).finally(() => { pending = undefined })
  }
  return {
    start() { tick(); timer = setInterval(tick, sampleMs) },
    async stop() {
      stopped = true
      clearInterval(timer)
      if (pending) await pending
      await collect().catch(() => undefined)
      const list = [...endpoints.values()]
      return {
        samples, sampleMs,
        processes: [...processes.values()],
        endpoints: list,
        // A peer is traffic; a bound/listening socket is only exposure and is reported apart.
        nonLoopback: list.filter(item => item.kind === 'peer' && !item.loopback),
        nonLoopbackListeners: list.filter(item => item.kind === 'listen' && !item.loopback),
        coverage: 'Sampled from /proc every sampleMs: a connection opened and closed between two samples is not seen. The bootstrap guard counts blocked requests independently.'
      }
    }
  }
}

/**
 * Terminates the processes of this run that are still alive: SIGTERM, a grace period, then
 * SIGKILL. Only processes whose environment carries this run's owner token or run-root marker
 * are signalled, so no foreign process can be hit even if a pid or process group is reused.
 */
export async function cleanupOwnedLinuxProcesses({ owner, runRoot, procRoot = '/proc', kill = (pid, signal) => process.kill(pid, signal), settleMs = 5000, graceMs = 10_000, pollMs = 200, selfPid = process.pid }) {
  const list = () => listOwnedLinuxProcesses({ owner, runRoot, procRoot, selfPid })
  // Processes that are already exiting (Xvfb after xvfb-run's trap) get settleMs first.
  const settleEnd = Date.now() + settleMs
  let remaining = await list()
  while (remaining.length && Date.now() < settleEnd) {
    await new Promise(resolve => setTimeout(resolve, pollMs))
    remaining = await list()
  }
  const deadline = Date.now() + graceMs
  const initiallyAlive = remaining.map(item => ({ ...item }))
  const terminated = []
  while (remaining.length && Date.now() < deadline) {
    for (const item of remaining) {
      if (!terminated.some(entry => entry.pid === item.pid)) {
        try { kill(item.pid, 'SIGTERM'); terminated.push({ pid: item.pid, comm: item.comm, signal: 'SIGTERM' }) } catch { /* exited meanwhile */ }
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
    remaining = await list()
  }
  const killed = []
  for (const item of remaining) {
    try { kill(item.pid, 'SIGKILL'); killed.push({ pid: item.pid, comm: item.comm, signal: 'SIGKILL' }) } catch { /* exited meanwhile */ }
  }
  if (killed.length) await new Promise(resolve => setTimeout(resolve, pollMs))
  const after = await list()
  return { initiallyAlive, terminated, killed, remainingAfter: after, clean: initiallyAlive.length === 0 && after.length === 0 }
}

/**
 * Runner CLI entry on Linux: refuses a used root, then re-executes the runner under
 * xvfb-run in its own process group, observes the run's processes and endpoints, and
 * cleans up only its own processes afterwards. Resolves to the process exit code.
 */
export async function relaunchIsolatedRunnerUnderXvfb(script, argv, { privateRoot, spawn = spawnChild, procRoot = '/proc', kill, env = process.env, execPath = process.execPath, platform = process.platform, sampleMs = 500, settleMs = 5000, graceMs = 10_000, log = message => console.log(message) } = {}) {
  assert(isLinuxIsolatedPlatform(platform), 'The xvfb relaunch is Linux only')
  assert(Array.isArray(argv) && argv.length >= 1 && argv[0] && !argv[0].startsWith('--'), 'Pass one new private run root')
  // Flags (--name) are forwarded; any other argument would be a worker path, which Linux never takes.
  const flags = argv.slice(1)
  assertNoLinuxWorkerSource(flags.find(value => !value.startsWith('--')))
  const runRoot = path.resolve(argv[0])
  await assertFreshIsolatedRunRoot(runRoot, privateRoot)
  const owner = randomUUID()
  const { command, args, env: childEnv } = linuxXvfbCommand({ script, args: [runRoot, ...flags], execPath, env, owner })
  const observer = createLinuxRunObserver({ owner, runRoot, procRoot, sampleMs })
  observer.start()
  const startedAt = new Date().toISOString()
  // Own process group (detached): the run's tree can be told apart from the caller's.
  const child = spawn(command, args, { env: childEnv, stdio: 'inherit', detached: true, shell: false })
  const forward = signal => { try { kill ? kill(-child.pid, signal) : process.kill(-child.pid, signal) } catch { /* group already gone */ } }
  const onInt = () => forward('SIGINT'), onTerm = () => forward('SIGTERM')
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
  let exit
  try {
    exit = await new Promise(resolve => {
      child.once('error', error => resolve({ code: null, signal: null, error: error.message }))
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
  } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm) }
  const network = await observer.stop()
  const cleanup = await cleanupOwnedLinuxProcesses({ owner, runRoot, procRoot, settleMs, graceMs, ...(kill ? { kill } : {}) })
  let electron = null
  try { electron = JSON.parse(await fs.readFile(path.join(defaultRepoRoot, 'node_modules/electron/package.json'), 'utf8')).version } catch { /* reported as unknown */ }
  const observation = {
    platform: 'linux', startedAt, finishedAt: new Date().toISOString(), runRoot, script: path.basename(script),
    xvfb: { command, screen: LINUX_XVFB_SCREEN }, electron, ownerToken: owner,
    exit, network, cleanup
  }
  const failed = exit.code !== 0 || network.nonLoopback.length > 0 || !cleanup.clean
  observation.status = failed ? 'failed' : 'passed'
  if (network.nonLoopback.length) observation.reason = 'non-loopback endpoint observed'
  else if (!cleanup.clean) observation.reason = 'processes of this run were still alive after it ended'
  const evidence = path.join(runRoot, 'evidence')
  let written = null
  try {
    if ((await fs.stat(evidence)).isDirectory()) {
      written = path.join(evidence, 'linux-host-observation.json')
      await fs.writeFile(written, JSON.stringify(observation, null, 2), { flag: 'wx' })
    }
  } catch { written = null }
  log('isolated-linux-host ' + JSON.stringify({ status: observation.status, reason: observation.reason ?? null, exit, electron, nonLoopback: network.nonLoopback, nonLoopbackListeners: network.nonLoopbackListeners, endpoints: network.endpoints.length, processes: network.processes.length, leftovers: cleanup.initiallyAlive.length, killed: cleanup.killed.length, report: written }))
  return failed ? 1 : 0
}
