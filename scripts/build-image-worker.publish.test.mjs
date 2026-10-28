import assert from 'node:assert/strict'
import test from 'node:test'
import { __publishBinaryAtomicallyForTest } from './build-image-worker.mjs'

function fixture() {
  const source = 'D:/source/worker.exe'
  const output = 'D:/output/worker.exe'
  const files = new Map([
    [source, { type: 'file', contents: 'new binary', nlink: 1 }],
    [output, { type: 'file', contents: 'old binary', nlink: 1 }]
  ])
  const fsModule = {
    lstatSync(file) {
      const value = files.get(file)
      if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return {
        isFile: () => value.type === 'file',
        isSymbolicLink: () => value.type === 'symlink',
        nlink: value.nlink
      }
    },
    readFileSync(file) {
      const value = files.get(file)
      if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return Buffer.from(value.contents)
    },
    mkdirSync: () => undefined,
    writeFileSync(file, bytes) {
      files.set(file, { type: 'file', contents: Buffer.from(bytes).toString(), nlink: 1 })
    },
    copyFileSync(from, to) {
      const value = files.get(from)
      if (!value) throw new Error('source missing')
      files.set(to, { ...value })
    },
    chmodSync: () => undefined,
    renameSync(from, to) {
      files.set(to, files.get(from))
      files.delete(from)
    },
    rmSync(file) {
      files.delete(file)
    }
  }
  return { source, output, files, fsModule }
}

test('publishes through a temporary file and preserves old output if copy fails', () => {
  const f = fixture()
  f.fsModule.copyFileSync = () => {
    throw new Error('copy failed')
  }
  assert.throws(
    () => __publishBinaryAtomicallyForTest(f.source, f.output, 'D:/output', f.fsModule, 'win32'),
    /copy failed/
  )
  assert.equal(f.files.get(f.output).contents, 'old binary')
})

test('replaces old output only after validating a regular source file', () => {
  const f = fixture()
  __publishBinaryAtomicallyForTest(f.source, f.output, 'D:/output', f.fsModule, 'win32')
  assert.equal(f.files.get(f.output).contents, 'new binary')
})

test('rejects a source directory without touching the output', () => {
  const f = fixture()
  f.files.set(f.source, { type: 'directory', contents: '', nlink: 1 })
  assert.throws(
    () => __publishBinaryAtomicallyForTest(f.source, f.output, 'D:/output', f.fsModule, 'win32'),
    /regular single-link/
  )
  assert.equal(f.files.get(f.output).contents, 'old binary')
})
