import fs from 'node:fs'
import path from 'node:path'

export function reuseEmbeddedPythonRequested(value) {
  if (value === undefined || value === '' || value === '0') return false
  if (value === '1') return true
  throw new Error('EMBEDDED_REUSE_PYTHON must be 0 or 1')
}

export function assertEmbeddedPythonReusePolicy({
  skipTorch,
  skipSmoke,
  strictSmoke,
  pruneRuntime
}) {
  if (skipTorch || skipSmoke || strictSmoke !== true || pruneRuntime !== true)
    throw new Error(
      'Embedded Python reuse requires the full Torch, pruning and strict smoke checks'
    )
}

const samePath = (a, b) =>
  typeof a === 'string' &&
  path.isAbsolute(a) &&
  (process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b))
const packageFile = (pythonDir, name) =>
  path.join(pythonDir, 'Lib', 'site-packages', name, '__init__.py')

export function validateReusedEmbeddedPython(
  report,
  { pythonDir, pythonVersion, torchRequirements }
) {
  if (
    report?.version !== pythonVersion ||
    report?.implementation !== 'CPython' ||
    report?.bits !== 64 ||
    !samePath(report?.executable, path.join(pythonDir, 'python.exe')) ||
    !samePath(report?.pip, packageFile(pythonDir, 'pip')) ||
    report?.cuda !== '13.0' ||
    report?.cpuTensorSum !== 3
  )
    throw new Error('Existing embedded Python runtime does not match this preparation')
  for (const requirement of torchRequirements) {
    const [name, version] = requirement.split('==')
    const item = report.packages?.[name]
    if (
      !version ||
      item?.version !== version ||
      !samePath(item?.file, packageFile(pythonDir, name))
    )
      throw new Error(`Existing embedded runtime does not match ${requirement}`)
  }
}

export function prepareEmbeddedPythonBase({ reuse, verify, extract, configure, bootstrap }) {
  if (reuse) verify()
  else {
    extract()
    configure()
    bootstrap()
  }
}

function assertRealDirectoryChain(directory) {
  const chain = [path.resolve(directory)]
  while (path.dirname(chain[0]) !== chain[0]) chain.unshift(path.dirname(chain[0]))
  for (const current of chain) {
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Existing embedded Python parents must be real directories')
  }
}

function assertRegularFile(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error('Existing embedded Python files must be regular single-link files')
}

// Reuse is only for caller-trusted build staging, not arbitrary Python installs.
// This rejects linked paths and validates the runtime contract; it does not
// authenticate every Python/package byte or replace the subsequent resolver/gates.
export function assertReusablePythonPaths(pythonDir, pythonVersion, repoRoot) {
  if (
    typeof repoRoot !== 'string' ||
    !path.isAbsolute(repoRoot) ||
    !samePath(pythonDir, path.join(repoRoot, '.staging', 'embedded', 'python_embeded')) ||
    !/^3\.\d+\.\d+$/.test(pythonVersion)
  )
    throw new Error('Reuse must target this repository embedded Python staging directory')
  const absolute = path.resolve(pythonDir)
  assertRealDirectoryChain(absolute)
  const pythonStem = `python${pythonVersion.split('.').slice(0, 2).join('')}`
  for (const name of ['python.exe', `${pythonStem}._pth`, `${pythonStem}.zip`, `${pythonStem}.dll`])
    assertRegularFile(path.join(absolute, name))
  const pth = fs
    .readFileSync(path.join(absolute, `${pythonStem}._pth`), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  const expected = ['../ComfyUI', `${pythonStem}.zip`, '.', 'import site']
  if (pth.length !== expected.length || pth.some((line, i) => line !== expected[i]))
    throw new Error('Existing embedded Python path configuration changed')
}

export function assertReusedEmbeddedModuleFiles(options) {
  for (const name of ['pip', ...options.torchRequirements.map((item) => item.split('==')[0])]) {
    const file = packageFile(options.pythonDir, name)
    assertRealDirectoryChain(path.dirname(file))
    assertRegularFile(file)
  }
}

export function assertReusedEmbeddedModulePaths(report, options) {
  validateReusedEmbeddedPython(report, options)
  assertReusedEmbeddedModuleFiles(options)
}
