import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('./run-electron-vite.mjs', import.meta.url), 'utf8')
const launcher = new vm.Script(
  source
    .split('\n')
    .filter((line) => !line.startsWith('import '))
    .join('\n'),
  {
    filename: 'run-electron-vite.mjs'
  }
)

function runLauncher(command, buildResult = { status: 0 }, platform = 'win32') {
  const calls = []
  const root = path.resolve('fixture workspace with spaces')
  const stop = new Error('process exited')
  const fakeProcess = {
    argv: ['node', 'scripts/run-electron-vite.mjs', command, '--mode', 'pure'],
    execPath: path.join(root, 'node executable'),
    env: { ELECTRON_CLI_ARGS: '["--owned-flag"]' },
    platform,
    pid: 123,
    cwd: () => root,
    once: () => {},
    kill: (pid, signal) => calls.push({ kind: 'kill', pid, signal }),
    exit: (code) => {
      calls.push({ kind: 'exit', code })
      throw stop
    }
  }
  try {
    launcher.runInNewContext({
      path,
      process: fakeProcess,
      console: { error: () => {} },
      killWindowsProcessTree: () => {},
      spawnSync: (file, args, options) => {
        calls.push({ kind: 'build', file, args, options })
        return buildResult
      },
      spawn: (file, args, options) => {
        calls.push({ kind: 'launch', file, args, options })
        return { pid: 456, on: () => {} }
      }
    })
  } catch (error) {
    if (error !== stop) throw error
  }
  return { calls, root, executable: fakeProcess.execPath }
}

test('dev builds the document worker without a shell before launch and propagates failures', () => {
  for (const platform of ['win32', 'linux']) {
    const { calls, root, executable } = runLauncher('dev', { status: 0 }, platform)
    assert.deepEqual(calls.map(({ kind }) => kind), ['build', 'launch'])
    const [build, launch] = calls
    assert.equal(build.file, executable)
    assert.deepEqual(Array.from(build.args), [path.join(root, 'scripts/build-document-worker.mjs')])
    assert.equal(build.options.shell, false)
    assert.equal(build.options.cwd, root)
    assert.equal(build.options.stdio, 'inherit')
    assert.equal(build.options.env.ELECTRON_CLI_ARGS, launch.options.env.ELECTRON_CLI_ARGS)
    assert.deepEqual(Array.from(launch.args), [
      'dev', '--config', 'config/electron/electron.vite.config.ts', '-w', '--mode', 'pure'
    ])
  }

  for (const [result, code] of [
    [{ status: 17 }, 17],
    [{ status: null, error: new Error('spawn failed') }, 1],
    [{ status: null }, 1]
  ]) {
    const { calls } = runLauncher('dev', result)
    assert.deepEqual(calls.map(({ kind }) => kind), ['build', 'exit'])
    assert.equal(calls.at(-1).code, code)
  }

  const signaled = runLauncher('dev', { status: null, signal: 'SIGTERM' }).calls
  assert.deepEqual(signaled.map(({ kind }) => kind), ['build', 'kill', 'exit'])
  assert.equal(signaled[1].signal, 'SIGTERM')
  assert.equal(signaled[1].pid, 123)
  assert.deepEqual(runLauncher('preview').calls.map(({ kind }) => kind), ['launch'])
})
