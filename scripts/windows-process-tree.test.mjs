import test from 'node:test'
import assert from 'node:assert/strict'
import { killWindowsProcessTree } from './windows-process-tree.mjs'

test('Windows process tree cleanup uses taskkill with tree and force flags', () => {
  const calls = []
  const result = killWindowsProcessTree(15756, (command, args, options) => {
    calls.push({ command, args, options })
  })

  if (process.platform === 'win32') {
    assert.equal(result, true)
    assert.deepEqual(calls, [
      {
        command: 'taskkill.exe',
        args: ['/PID', '15756', '/T', '/F'],
        options: { stdio: 'ignore', windowsHide: true }
      }
    ])
  } else {
    assert.equal(result, false)
    assert.deepEqual(calls, [])
  }
})

test('Windows process tree cleanup ignores invalid pids', () => {
  const calls = []
  assert.equal(
    killWindowsProcessTree(0, (...args) => calls.push(args)),
    false
  )
  assert.deepEqual(calls, [])
})
