import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import {
  assertEmbeddedPythonReusePolicy,
  assertReusablePythonPaths,
  assertReusedEmbeddedModuleFiles,
  assertReusedEmbeddedModulePaths,
  reuseEmbeddedPythonRequested,
  validateReusedEmbeddedPython,
  prepareEmbeddedPythonBase
} from './embedded-python-reuse.mjs'

vi.unmock('node:fs')

const pythonDir = path.resolve('synthetic-repo/.staging/embedded/python_embeded')
const options = {
  pythonDir,
  pythonVersion: '3.13.11',
  torchRequirements: [
    'torch==2.11.0+cu130',
    'torchvision==0.26.0+cu130',
    'torchaudio==2.11.0+cu130'
  ]
}
const report = (root = pythonDir) => ({
  executable: path.join(root, 'python.exe'),
  version: '3.13.11',
  implementation: 'CPython',
  bits: 64,
  pip: path.join(root, 'Lib/site-packages/pip/__init__.py'),
  cuda: '13.0',
  cpuTensorSum: 3,
  packages: Object.fromEntries(
    options.torchRequirements.map((requirement) => {
      const [name, version] = requirement.split('==')
      return [name, { version, file: path.join(root, `Lib/site-packages/${name}/__init__.py`) }]
    })
  )
})
const roots = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  // All fixtures stay in this test worktree. No staged interpreter is executed.
  const tempRoot = path.join(process.cwd(), '.cache')
  fs.mkdirSync(tempRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(tempRoot, 'embedded-reuse-test-'))
  roots.push(root)
  const python = path.join(root, '.staging/embedded/python_embeded')
  fs.mkdirSync(python, { recursive: true })
  for (const name of ['python.exe', 'python313.zip', 'python313.dll'])
    fs.writeFileSync(path.join(python, name), 'synthetic fixture, never executed')
  fs.writeFileSync(
    path.join(python, 'python313._pth'),
    '../ComfyUI\npython313.zip\n.\nimport site\n'
  )
  const value = report(python)
  for (const file of [value.pip, ...Object.values(value.packages).map((item) => item.file)]) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '# synthetic module, never imported\n')
  }
  return { root, python, value, options: { ...options, pythonDir: python } }
}

describe('explicit embedded Python reuse without skipping resolver or gates', () => {
  it('is opt-in and rejects ambiguous values', () => {
    for (const value of [undefined, '', '0'])
      expect(reuseEmbeddedPythonRequested(value)).toBe(false)
    expect(reuseEmbeddedPythonRequested('1')).toBe(true)
    for (const value of ['true', 'yes', '2', ' 1'])
      expect(() => reuseEmbeddedPythonRequested(value)).toThrow()
  })
  it('retains default extraction/configuration/bootstrap order', () => {
    const calls = []
    prepareEmbeddedPythonBase(
      Object.fromEntries(
        ['verify', 'extract', 'configure', 'bootstrap'].map((name) => [
          name,
          () => calls.push(name)
        ])
      )
    )
    expect(calls).toEqual(['extract', 'configure', 'bootstrap'])
  })
  it('verifies reuse rather than deleting or bootstrapping its interpreter', () => {
    const calls = []
    prepareEmbeddedPythonBase({
      reuse: true,
      ...Object.fromEntries(
        ['verify', 'extract', 'configure', 'bootstrap'].map((name) => [
          name,
          () => calls.push(name)
        ])
      )
    })
    expect(calls).toEqual(['verify'])
  })
  it('fails closed on verification failure without automatic destructive fallback', () => {
    const extract = vi.fn()
    expect(() =>
      prepareEmbeddedPythonBase({
        reuse: true,
        verify() {
          throw new Error('mismatch')
        },
        extract
      })
    ).toThrow('mismatch')
    expect(extract).not.toHaveBeenCalled()
  })
  it.each([
    { skipTorch: true, skipSmoke: false, strictSmoke: true, pruneRuntime: true },
    { skipTorch: false, skipSmoke: true, strictSmoke: true, pruneRuntime: true },
    { skipTorch: false, skipSmoke: false, strictSmoke: false, pruneRuntime: true },
    { skipTorch: false, skipSmoke: false, strictSmoke: true, pruneRuntime: false }
  ])('rejects weakened reuse checks %j', (policy) => {
    expect(() => assertEmbeddedPythonReusePolicy(policy)).toThrow(
      'full Torch, pruning and strict smoke'
    )
  })
  it('accepts only the strict reuse policy', () => {
    expect(() =>
      assertEmbeddedPythonReusePolicy({
        skipTorch: false,
        skipSmoke: false,
        strictSmoke: true,
        pruneRuntime: true
      })
    ).not.toThrow()
  })
  it('accepts exact interpreter, package versions, in-stage paths and real CPU probe', () => {
    expect(() => validateReusedEmbeddedPython(report(), options)).not.toThrow()
  })
  it.each([
    { version: '3.12.0' },
    { bits: 32 },
    { implementation: 'PyPy' },
    { cuda: '12.8' },
    { cpuTensorSum: 0 },
    { executable: path.resolve('outside/python.exe') },
    { pip: path.resolve('outside/pip.py') },
    { executable: 'python.exe' },
    { pip: 'Lib/site-packages/pip/__init__.py' },
    { pip: path.join(pythonDir, 'shadow/pip.py') }
  ])('rejects mismatching runtime report %j', (patch) => {
    expect(() => validateReusedEmbeddedPython({ ...report(), ...patch }, options)).toThrow()
  })
  it.each([null, {}, [], 'invalid'])('rejects malformed runtime report %j', (value) => {
    expect(() => validateReusedEmbeddedPython(value, options)).toThrow()
  })
  it('rejects changed versions, missing package reports and packages outside stage', () => {
    for (const patch of [
      { version: '2.11.0' },
      { version: '2.11.0+cu130', file: path.resolve('outside/torch.py') },
      { version: '2.11.0+cu130', file: path.join(pythonDir, 'shadow/torch.py') },
      undefined
    ]) {
      const value = report()
      value.packages.torch = patch
      expect(() => validateReusedEmbeddedPython(value, options)).toThrow()
    }
  })
  it('accepts only this repository stage with regular runtime and module paths', () => {
    const f = fixture()
    expect(() => assertReusablePythonPaths(f.python, '3.13.11', f.root)).not.toThrow()
    expect(() => assertReusedEmbeddedModulePaths(f.value, f.options)).not.toThrow()
  })
  it('refuses a Python directory from another repository or wrong staging location', () => {
    const f = fixture()
    for (const candidate of [path.join(f.root, 'python_embeded'), path.dirname(f.python), f.root])
      expect(() => assertReusablePythonPaths(candidate, '3.13.11', f.root)).toThrow(
        'this repository'
      )
    expect(() => assertReusablePythonPaths(f.python, '3.13.11', `${f.root}-other`)).toThrow(
      'this repository'
    )
  })
  it.each(['python.exe', 'python313.dll', 'python313.zip', 'python313._pth'])(
    'refuses missing, directory or hardlinked %s without touching it',
    (name) => {
      const f = fixture(),
        file = path.join(f.python, name)
      fs.unlinkSync(file)
      expect(() => assertReusablePythonPaths(f.python, '3.13.11', f.root)).toThrow()
      fs.mkdirSync(file)
      expect(() => assertReusablePythonPaths(f.python, '3.13.11', f.root)).toThrow(
        'regular single-link'
      )
      fs.rmdirSync(file)
      const target = path.join(f.root, 'target')
      fs.writeFileSync(target, 'retained')
      fs.linkSync(target, file)
      expect(() => assertReusablePythonPaths(f.python, '3.13.11', f.root)).toThrow(
        'regular single-link'
      )
      expect(fs.readFileSync(target, 'utf8')).toBe('retained')
    }
  )
  it('refuses real stage parent junctions without modifying their target', () => {
    const f = fixture(),
      stage = path.join(f.root, '.staging'),
      moved = path.join(f.root, 'moved-stage')
    fs.renameSync(stage, moved)
    fs.symlinkSync(moved, stage, process.platform === 'win32' ? 'junction' : 'dir')
    expect(fs.lstatSync(stage).isSymbolicLink()).toBe(true)
    expect(() => assertReusablePythonPaths(f.python, '3.13.11', f.root)).toThrow('real directories')
    expect(
      fs.readFileSync(path.join(moved, 'embedded/python_embeded/python.exe'), 'utf8')
    ).toContain('synthetic')
  })
  it('refuses linked import package directories without modifying their target', () => {
    const f = fixture(),
      packageDir = path.dirname(f.value.packages.torch.file)
    const moved = path.join(f.root, 'original-torch')
    fs.renameSync(packageDir, moved)
    fs.symlinkSync(moved, packageDir, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => assertReusedEmbeddedModuleFiles(f.options)).toThrow('real directories')
    expect(() => assertReusedEmbeddedModulePaths(f.value, f.options)).toThrow('real directories')
    expect(fs.readFileSync(path.join(moved, '__init__.py'), 'utf8')).toContain('synthetic')
  })
  it.each([
    '../outside\n',
    '../ComfyUI\npython313.zip\n.\nimport site\n../outside\n',
    '../ComfyUI\npython313.zip\n.\n'
  ])('rejects altered path configuration %j', (pth) => {
    const f = fixture()
    fs.writeFileSync(path.join(f.python, 'python313._pth'), pth)
    expect(() => assertReusablePythonPaths(f.python, '3.13.11', f.root)).toThrow(
      'path configuration'
    )
  })
  it('keeps the same unconditional locked Torch transaction and every final gate after either base path', () => {
    const source = fs.readFileSync(
      new URL('./prepare-embedded-python.mjs', import.meta.url),
      'utf8'
    )
    const base = source.indexOf('prepareEmbeddedPythonBase({')
    const phases = [
      "runPhase('write-constraints'",
      "runPhase('install-torch'",
      "runPhase('install-requirements'",
      "runPhase('install-verified-llama-cpp'",
      "runPhase('verify-final-dependencies'",
      "runPhase('verify-augmentation-packages'",
      "runPhase('prune-runtime'",
      "runPhase('remove-python-caches-before-smoke'",
      "runPhase('comfy-quick-test'",
      "runPhase('remove-python-caches-after-smoke'"
    ]
    let previous = base
    expect(base).toBeGreaterThan(-1)
    for (const phase of phases) {
      const index = source.indexOf(phase)
      expect(index).toBeGreaterThan(previous)
      previous = index
    }
    expect(source).toContain(
      'assertEmbeddedPythonReusePolicy({ skipTorch, skipSmoke, strictSmoke, pruneRuntime })'
    )
    expect(source).toContain('assertReusablePythonPaths(pythonDir, pythonVersion, repoRoot)')
    expect(source).toContain('assertReusedEmbeddedModulePaths(JSON.parse(result.stdout)')
    expect(source).toContain(
      "if (result.status !== 0) throw new Error('Existing embedded Python import probe failed')"
    )
    const preflight = source.indexOf(
      'assertReusedEmbeddedModuleFiles({ pythonDir, torchRequirements: embeddedTorchRequirements })'
    )
    expect(preflight).toBeGreaterThan(source.indexOf('function verifyExistingPython()'))
    expect(preflight).toBeLessThan(
      source.indexOf('const result = runCapture(pythonExe(), [', preflight)
    )
    expect(source).toMatch(
      /if \(!reusePython\) \{\s*await ensureDownloaded\(pythonZipUrl, pythonZipPath\)\s*await ensureDownloaded\(getPipUrl, getPipPath\)\s*\}/
    )
    expect(source).toContain('const llamaCppWheelPath = await ensureVerifiedLlamaCppWheel()')
    expect(source).toMatch(/'--index-url',\s*torchIndexUrl/)
  })
})
