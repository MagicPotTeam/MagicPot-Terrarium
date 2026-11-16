// Runner-level platform checks with fake platforms. Every case is refused before a file, socket,
// display or process is created: no Electron, cargo, xvfb or network is started here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedImageEnvironment, runIsolatedImageDesktop } from './isolatedImageDesktopAcceptance.mjs'
import { runIsolatedTeamDesktop } from './isolatedTeamDesktopAcceptance.mjs'
import { runIsolatedTeamChannelDesktop } from './isolatedTeamChannelAcceptance.mjs'
import { runIsolatedTeamDesignerDesktop } from './isolatedTeamDesignerDesktopAcceptance.mjs'
import { runIsolatedTeamWriterDesktop } from './isolatedTeamWriterDesktopAcceptance.mjs'
import { runIsolatedThreadGoalsDesktop } from './isolatedThreadGoalsDesktopAcceptance.mjs'
import { runLeadSummaryLauncher } from './isolatedTeamLeadSummaryLauncher.mjs'
import { LINUX_XVFB_ENV, LINUX_OWNER_ENV } from './isolatedDesktopPlatform.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const privateRoot = path.resolve(repoRoot, '../../.magicpot-trash')
// A root inside the private area that is never created by these tests.
const absentRoot = () => path.join(privateRoot, 'MagicPot', 'k5-unit-absent-' + randomUUID())

const runners = [
  ['image', (root, worker, platform) => runIsolatedImageDesktop(root, worker, { platform, crashTwice: false }), /owned private worker/],
  ['team', (root, worker, platform) => runIsolatedTeamDesktop(root, worker, { platform }), /owned private worker/],
  ['channel', (root, worker, platform) => runIsolatedTeamChannelDesktop(root, worker, { platform }), /owned worker/],
  ['designer', (root, worker, platform) => runIsolatedTeamDesignerDesktop(root, worker, { platform }), /owned private worker/],
  ['writer', (root, worker, platform) => runIsolatedTeamWriterDesktop(root, worker, { platform }), /owned private worker/],
  ['goals', (root, worker, platform) => runIsolatedThreadGoalsDesktop(root, worker, { platform }), /existing private worker/]
]

for (const [name, run, windowsWorkerMessage] of runners) {
  test(`${name} runner: linux refuses a worker path, win32 still requires one; nothing is created`, async () => {
    const root = absentRoot()
    await assert.rejects(run(root, path.join(privateRoot, 'worker.exe'), 'linux'), /do not pass a worker path/)
    // Unchanged Windows guard: a relative (non-private) worker is refused before any file access.
    await assert.rejects(run(root, 'worker.exe', 'win32'), windowsWorkerMessage)
    assert.equal(fs.existsSync(root), false)
  })

  test(`${name} runner: linux refuses a root that is not a fresh built root before creating anything`, async () => {
    const root = absentRoot()
    await assert.rejects(run(root, undefined, 'linux'), /ENOENT|never-run root|canonical/)
    await assert.rejects(run('/tmp/k5-outside-private-root', undefined, 'linux'), /private|Invalid isolated run root/i)
    assert.equal(fs.existsSync(root), false)
  })
}

test('lead summary launcher stays disabled on both platforms before any preflight', async () => {
  for (const platform of ['win32', 'linux']) {
    await assert.rejects(runLeadSummaryLauncher(absentRoot(), undefined, { platform }), /launcher disabled.*quarantine/i)
  }
})

test('isolated environment: win32 is the original set, linux adds only the private Linux keys', () => {
  const runRoot = path.join(privateRoot, 'MagicPot', 'k5-env')
  const windows = isolatedImageEnvironment(runRoot, path.resolve(privateRoot, '..'), 'k5-env', 'win32')
  const linux = isolatedImageEnvironment(runRoot, path.resolve(privateRoot, '..'), 'k5-env', 'linux')
  assert.equal(windows.MAGICPOT_CANVAS_THUMBNAIL_SIDECAR_PATH, path.join(runRoot, 'bin/canvas-thumbnail-sidecar.exe'))
  assert.equal(linux.MAGICPOT_CANVAS_THUMBNAIL_SIDECAR_PATH, path.join(runRoot, 'bin', 'canvas-thumbnail-sidecar'))
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'LANG', 'MAGICPOT_PRIVATE_TEST_SKIP_LEGACY_USER_DATA_MIGRATION', 'MAGICPOT_PRIVATE_LIVE_SYNC']) {
    assert.equal(Object.hasOwn(windows, key), false, key)
  }
  const added = Object.keys(linux).filter(key => !Object.hasOwn(windows, key)).sort()
  const expected = ['HOME', 'LANG', 'MAGICPOT_PRIVATE_LIVE_SYNC', 'MAGICPOT_PRIVATE_TEST_SKIP_LEGACY_USER_DATA_MIGRATION', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']
  if (process.env.DISPLAY) expected.push('DISPLAY')
  if (process.env.XAUTHORITY) expected.push('XAUTHORITY')
  assert.deepEqual(added, expected.sort())
  for (const [key, value] of Object.entries(windows)) {
    if (key !== 'MAGICPOT_CANVAS_THUMBNAIL_SIDECAR_PATH') assert.equal(linux[key], value, key)
  }
  assert.equal(linux.VITE_MAGICPOT_AUTO_START_COMFYUI, 'false')
  assert.equal(linux.MAGICPOT_MCP_STDIO_SERVER, '0')
  assert.equal(Object.hasOwn(linux, 'NODE_OPTIONS'), false)
})

const cli = (script, args, env = {}) => {
  const childEnv = { ...process.env, ...env }
  delete childEnv[LINUX_XVFB_ENV]
  delete childEnv[LINUX_OWNER_ENV]
  return spawnSync(process.execPath, [path.join(here, script), ...args], { env: childEnv, encoding: 'utf8', timeout: 60_000 })
}

test('linux CLI refuses a root outside the private area and a worker argument before starting xvfb', { skip: process.platform !== 'linux' }, () => {
  const outside = cli('isolatedTeamDesktopAcceptance.mjs', ['/tmp/k5-not-a-private-root'])
  assert.notEqual(outside.status, 0)
  assert.match(outside.stderr, /MagicPot\/<run id>/)
  const root = absentRoot()
  const withWorker = cli('isolatedTeamDesktopAcceptance.mjs', [root, path.join(privateRoot, 'worker.exe')])
  assert.notEqual(withWorker.status, 0)
  assert.match(withWorker.stderr, /do not pass a worker path/)
  assert.doesNotMatch(outside.stdout + withWorker.stdout, /isolated-linux-host/)
  assert.equal(fs.existsSync(root), false)
})

test('trigger runner refuses on linux without deleting, copying or launching anything', { skip: process.platform !== 'linux' }, () => {
  const fixedRoot = path.join(privateRoot, 'MagicPot', 'trigger-desktop-acceptance-20261113-1')
  const before = fs.existsSync(fixedRoot) ? fs.readdirSync(fixedRoot).sort() : null
  const result = cli('isolatedTriggerDesktopAcceptance.mjs', [])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not available on Linux/)
  assert.deepEqual(fs.existsSync(fixedRoot) ? fs.readdirSync(fixedRoot).sort() : null, before)
})
