import assert from 'node:assert/strict'
import test from 'node:test'
import { isSafeRelativePath, isValidBuildId, isValidRuntimeId, isValidSemanticVersion, planRelease } from './package-signed-launcher-release.ts'

const old = { ...process.env }
test.afterEach(() => { process.env = { ...old } })

test('local protocol validators remain importable without Electron runtime modules', () => {
  assert.equal(isValidSemanticVersion('1.2.3-beta.1+build.7'), true)
  assert.equal(isValidSemanticVersion('01.2.3'), false)
  assert.equal(isSafeRelativePath('python_embeded/python.exe'), true)
  assert.equal(isSafeRelativePath('../python.exe'), false)
  assert.equal(isValidBuildId('20250102-030405-abcdef0'), true)
  assert.equal(isValidBuildId('20250230-030405-abcdef0'), false)
  assert.equal(isValidRuntimeId('embedded-1.2.3-win32-x64'), true)
  assert.equal(isValidRuntimeId('embedded..runtime'), false)
})

test('planning fails closed when required configuration is absent', () => {
  for (const key of Object.keys(process.env)) if (key.startsWith('LAUNCHER_')) delete process.env[key]
  assert.throws(() => planRelease([]), /missing --channel/)
})

test('planning rejects unsupported platform and ABI before touching inputs', () => {
  assert.throws(() => planRelease(['--channel', 'stable', '--version', '1.2.3', '--build-id', '20250102-030405-abcdef0', '--commit-sha', 'abcdef0123456789abcdef0123456789abcdef01', '--platform', 'linux', '--abi', 'x64']), /only platform=win32/)
})

test('planning rejects duplicate CLI values', () => {
  assert.throws(() => planRelease(['--channel', 'stable', '--channel', 'beta']), /duplicate --channel/)
})

test('ComfyUI entrypoint is explicit because it must be relative to the runtime artifact root', () => {
  assert.throws(() => planRelease(['--channel', 'stable', '--version', '1.2.3', '--build-id', '20250102-030405-abcdef0', '--commit-sha', 'abcdef0123456789abcdef0123456789abcdef01', '--platform', 'win32', '--abi', 'x64', '--runtime-id', 'runtime-1', '--generated-at', '2025-01-02T03:04:05Z']), /missing --comfyui-entrypoint/)
})
