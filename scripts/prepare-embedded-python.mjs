#!/usr/bin/env node
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const stagingRoot = path.join(repoRoot, '.staging', 'embedded')
const comfyDir = path.join(stagingRoot, 'ComfyUI')
const pythonDir = path.join(stagingRoot, 'python_embeded')
const cacheRoot = path.join(repoRoot, '.cache', 'embedded-python')

const pythonVersion = process.env.EMBEDDED_PYTHON_VERSION || '3.13.11'
const pythonArch = process.env.EMBEDDED_PYTHON_ARCH || 'amd64'
const pythonZipName = `python-${pythonVersion}-embed-${pythonArch}.zip`
const pythonZipUrl =
  process.env.EMBEDDED_PYTHON_ZIP_URL ||
  `https://www.python.org/ftp/python/${pythonVersion}/${pythonZipName}`
const getPipUrl = process.env.EMBEDDED_GET_PIP_URL || 'https://bootstrap.pypa.io/get-pip.py'
const torchIndexUrl =
  process.env.EMBEDDED_TORCH_INDEX_URL || 'https://download.pytorch.org/whl/cu130'
const llamaCppIndexUrl =
  process.env.EMBEDDED_LLAMA_CPP_INDEX_URL ||
  'https://abetlen.github.io/llama-cpp-python/whl/cpu'
const llamaCppPythonVersion = process.env.EMBEDDED_LLAMA_CPP_PYTHON_VERSION || '0.3.19'
const transformersVersion = process.env.EMBEDDED_TRANSFORMERS_VERSION || '4.57.6'
const huggingfaceHubVersion = process.env.EMBEDDED_HUGGINGFACE_HUB_VERSION || '0.36.2'
const decoratorVersion = process.env.EMBEDDED_DECORATOR_VERSION || '4.4.2'

const skipTorch = process.env.EMBEDDED_SKIP_TORCH === '1'
const skipSmoke = process.env.EMBEDDED_SKIP_SMOKE === '1'
const strictSmoke = process.env.EMBEDDED_STRICT_SMOKE !== '0'
const dryRun = process.env.EMBEDDED_DRY_RUN === '1'
const requirementsMode = process.env.EMBEDDED_REQUIREMENTS_MODE || 'prefer-fixed'
const pruneRuntime = process.env.EMBEDDED_PRUNE_RUNTIME !== '0'
const keepOnnxRuntimeGpu = process.env.EMBEDDED_KEEP_ONNXRUNTIME_GPU === '1'
const keepTorchMultiGpuSolver = process.env.EMBEDDED_KEEP_TORCH_MULTI_GPU_SOLVER === '1'
const keepTorchNvrtcAlt = process.env.EMBEDDED_KEEP_TORCH_NVRTC_ALT === '1'
const keepUvInstaller = process.env.EMBEDDED_KEEP_UV_INSTALLER === '1'

function assertInsideRepo(targetPath) {
  const resolved = path.resolve(targetPath)
  const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : `${repoRoot}${path.sep}`
  if (resolved !== repoRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Refusing to touch path outside repo: ${resolved}`)
  }
  return resolved
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function removeDir(dirPath) {
  const resolved = assertInsideRepo(dirPath)
  if (fs.existsSync(resolved)) {
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

function assertInsideEmbeddedStage(targetPath) {
  const resolved = path.resolve(targetPath)
  const rootWithSep = stagingRoot.endsWith(path.sep) ? stagingRoot : `${stagingRoot}${path.sep}`
  if (resolved !== stagingRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Refusing to touch path outside embedded staging: ${resolved}`)
  }
  return resolved
}

function run(command, args, options = {}) {
  console.log(`[prepare-embedded-python] ${command} ${args.join(' ')}`)
  execFileSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONNOUSERSITE: '1'
    },
    stdio: 'inherit'
  })
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONNOUSERSITE: '1'
    },
    encoding: 'utf8'
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  return result
}

function downloadFile(url, destination, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error(`Too many redirects while downloading ${url}`))
  }

  ensureDir(path.dirname(destination))
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume()
        const redirectedUrl = new URL(response.headers.location, url).toString()
        downloadFile(redirectedUrl, destination, redirectCount + 1).then(resolve, reject)
        return
      }

      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`Download failed (${response.statusCode}): ${url}`))
        return
      }

      const tempPath = `${destination}.tmp`
      const file = fs.createWriteStream(tempPath)
      response.pipe(file)
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(tempPath, destination)
          resolve()
        })
      })
      file.on('error', reject)
    })
    request.on('error', reject)
  })
}

async function ensureDownloaded(url, destination) {
  if (fs.existsSync(destination) && process.env.EMBEDDED_FORCE_DOWNLOAD !== '1') {
    console.log(`[prepare-embedded-python] Reusing ${destination}`)
    return
  }
  console.log(`[prepare-embedded-python] Downloading ${url}`)
  await downloadFile(url, destination)
}

function extractPython(zipPath) {
  removeDir(pythonDir)
  ensureDir(pythonDir)

  try {
    run('tar', ['-xf', zipPath, '-C', pythonDir])
  } catch (error) {
    if (process.platform !== 'win32') throw error
    run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${pythonDir.replaceAll("'", "''")}' -Force`
    ])
  }
}

function configureEmbeddedPythonPath() {
  const [major, minor] = pythonVersion.split('.')
  const pthFile = path.join(pythonDir, `python${major}${minor}._pth`)
  if (!fs.existsSync(pthFile)) {
    throw new Error(`Missing Python path file: ${pthFile}`)
  }

  const lines = fs.readFileSync(pthFile, 'utf8').split(/\r?\n/)
  const normalized = lines
    .map((line) => (line.trim() === '#import site' ? 'import site' : line))
    .filter((line) => line.trim() !== '../ComfyUI')

  normalized.unshift('../ComfyUI')
  if (!normalized.some((line) => line.trim() === 'import site')) {
    normalized.push('import site')
  }

  fs.writeFileSync(pthFile, `${normalized.join('\n')}\n`)
}

function pythonExe() {
  const exe = path.join(pythonDir, process.platform === 'win32' ? 'python.exe' : 'python')
  if (!fs.existsSync(exe)) {
    throw new Error(`Missing staged Python executable: ${exe}`)
  }
  return exe
}

function pip(args) {
  run(pythonExe(), [
    '-s',
    '-m',
    'pip',
    '--disable-pip-version-check',
    '--retries',
    '5',
    '--timeout',
    '120',
    ...args
  ])
}

function extraIndexArgs() {
  return ['--extra-index-url', torchIndexUrl, '--extra-index-url', llamaCppIndexUrl]
}

function writeConstraints() {
  const constraintsPath = path.join(stagingRoot, 'constraints.txt')
  fs.writeFileSync(
    constraintsPath,
    [
      `llama-cpp-python==${llamaCppPythonVersion}`,
      `transformers==${transformersVersion}`,
      `huggingface-hub==${huggingfaceHubVersion}`,
      `decorator==${decoratorVersion}`,
      ''
    ].join('\n')
  )
  return constraintsPath
}

function bootstrapPip(getPipPath) {
  run(pythonExe(), ['-s', getPipPath])
  pip(['install', '--upgrade', 'pip', 'setuptools', 'wheel'])
}

function installTorchStack() {
  if (skipTorch) {
    console.log('[prepare-embedded-python] Skipping torch install because EMBEDDED_SKIP_TORCH=1')
    return
  }
  pip([
    'install',
    '--upgrade',
    '--prefer-binary',
    'torch',
    'torchvision',
    'torchaudio',
    ...extraIndexArgs()
  ])
}

function walkFiles(root, onFile) {
  if (!fs.existsSync(root)) return
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      walkFiles(entryPath, onFile)
    } else if (entry.isFile()) {
      onFile(entryPath)
    }
  }
}

function walkDirs(root, onDir) {
  if (!fs.existsSync(root)) return
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const entryPath = path.join(root, entry.name)
    onDir(entryPath, entry.name)
    walkDirs(entryPath, onDir)
  }
}

function getCustomNodeRequirementFiles() {
  const requirementFiles = []
  walkFiles(path.join(comfyDir, 'custom_nodes'), (filePath) => {
    if (/^requirements.*\.txt$/i.test(path.basename(filePath))) {
      requirementFiles.push(filePath)
    }
  })
  requirementFiles.sort((a, b) => a.localeCompare(b))

  if (requirementsMode === 'all') {
    return requirementFiles
  }

  const byDir = new Map()
  for (const filePath of requirementFiles) {
    const dir = path.dirname(filePath)
    const current = byDir.get(dir) || []
    current.push(filePath)
    byDir.set(dir, current)
  }

  const selected = []
  for (const files of byDir.values()) {
    const fixed = files.find((filePath) => path.basename(filePath).toLowerCase() === 'requirements_fixed.txt')
    const regular = files.find((filePath) => path.basename(filePath).toLowerCase() === 'requirements.txt')
    selected.push(fixed || regular || files[0])
  }

  return selected.sort((a, b) => a.localeCompare(b))
}

function installRequirements(constraintsPath) {
  const comfyRequirements = path.join(comfyDir, 'requirements.txt')
  if (!fs.existsSync(comfyRequirements)) {
    throw new Error(`Missing ComfyUI requirements: ${comfyRequirements}`)
  }

  pip([
    'install',
    '--upgrade',
    '--prefer-binary',
    '-r',
    comfyRequirements,
    '-c',
    constraintsPath,
    ...extraIndexArgs()
  ])

  const customRequirementFiles = getCustomNodeRequirementFiles()
  const manifestPath = path.join(stagingRoot, 'custom-node-requirements.json')
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(customRequirementFiles.map((filePath) => path.relative(stagingRoot, filePath)), null, 2)}\n`
  )

  for (const requirementsFile of customRequirementFiles) {
    console.log(
      `[prepare-embedded-python] Installing ${path.relative(stagingRoot, requirementsFile)}`
    )
    pip([
      'install',
      '--upgrade',
      '--prefer-binary',
      '-r',
      requirementsFile,
      '-c',
      constraintsPath,
      ...extraIndexArgs()
    ])
  }

  pip(['check'])
}

function installSmokeRuntimeExtras() {
  pip([
    'install',
    '--upgrade',
    '--prefer-binary',
    `llama-cpp-python==${llamaCppPythonVersion}`,
    'rotary-embedding-torch',
    ...extraIndexArgs()
  ])

  // smZNodes imports compel, but installing compel with full dependencies pulls notebook/ipython
  // and conflicts with moviepy's decorator pin. Existing ComfyUI deps cover the imports it uses.
  pip(['install', '--upgrade', '--prefer-binary', '--no-deps', 'compel==2.3.1'])

  // comfyui_LLM_party attempts to install this during startup; install it here so smoke tests
  // do not mutate the staged environment.
  pip(['install', '--upgrade', '--prefer-binary', 'py-cord[voice]'])
}

function removePythonCaches() {
  function removePycacheDirs(root) {
    if (!fs.existsSync(root)) return
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const entryPath = path.join(root, entry.name)
      if (!entry.isDirectory()) continue
      if (entry.name === '__pycache__') {
        fs.rmSync(entryPath, { recursive: true, force: true })
      } else {
        removePycacheDirs(entryPath)
      }
    }
  }

  for (const root of [pythonDir, comfyDir]) {
    walkFiles(root, (filePath) => {
      if (filePath.endsWith('.pyc')) {
        fs.rmSync(filePath, { force: true })
      }
    })
    removePycacheDirs(root)
  }
}

function directorySizeBytes(dirPath) {
  let bytes = 0
  walkFiles(dirPath, (filePath) => {
    bytes += fs.statSync(filePath).size
  })
  return bytes
}

function removeRuntimePath(targetPath, stats) {
  if (!fs.existsSync(targetPath)) return

  const resolved = assertInsideEmbeddedStage(targetPath)
  const fileStats = fs.statSync(resolved)
  const bytes = fileStats.isDirectory() ? directorySizeBytes(resolved) : fileStats.size

  fs.rmSync(resolved, { recursive: fileStats.isDirectory(), force: true })
  stats.bytes += bytes
  if (fileStats.isDirectory()) {
    stats.directories += 1
  } else {
    stats.files += 1
  }
}

function pruneEmbeddedRuntime() {
  if (!pruneRuntime) {
    console.log('[prepare-embedded-python] Skipping runtime pruning because EMBEDDED_PRUNE_RUNTIME=0')
    return
  }

  const sitePackages = path.join(pythonDir, 'Lib', 'site-packages')
  const stats = { bytes: 0, directories: 0, files: 0 }
  const prunableExtensions = new Set([
    '.pyc',
    '.pyo',
    '.lib',
    '.pdb',
    '.exp',
    '.h',
    '.hpp',
    '.c',
    '.cpp',
    '.cu',
    '.map',
    '.chm'
  ])
  const prunableDirectoryNames = new Set([
    'benchmark',
    'benchmarks',
    'example',
    'examples',
    'test',
    'tests'
  ])

  function shouldKeepPrunableDirectory(dirPath) {
    const normalized = path.relative(sitePackages, dirPath).split(path.sep).join('/')
    return normalized === 'torch/testing' || normalized.startsWith('torch/testing/')
  }

  for (const root of [pythonDir, comfyDir]) {
    walkFiles(root, (filePath) => {
      if (prunableExtensions.has(path.extname(filePath).toLowerCase())) {
        removeRuntimePath(filePath, stats)
      }
    })
  }

  walkDirs(pythonDir, (dirPath, dirName) => {
    if (dirName === '__pycache__' || dirName === '.pytest_cache') {
      removeRuntimePath(dirPath, stats)
    }
  })

  walkDirs(pythonDir, (dirPath, dirName) => {
    if (dirName === 'include' || dirName === 'Include') {
      removeRuntimePath(dirPath, stats)
    }
  })

  for (const root of [pythonDir, comfyDir]) {
    walkDirs(root, (dirPath, dirName) => {
      if (prunableDirectoryNames.has(dirName) && !shouldKeepPrunableDirectory(dirPath)) {
        removeRuntimePath(dirPath, stats)
      }
    })
  }

  if (fs.existsSync(sitePackages)) {
    for (const entry of fs.readdirSync(sitePackages, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('comfyui_workflow_templates_media_')) {
        continue
      }

      removeRuntimePath(path.join(sitePackages, entry.name, 'templates'), stats)
    }

    const bitsAndBytesDir = path.join(sitePackages, 'bitsandbytes')
    if (fs.existsSync(bitsAndBytesDir)) {
      for (const entry of fs.readdirSync(bitsAndBytesDir, { withFileTypes: true })) {
        if (entry.isFile() && /^libbitsandbytes_cuda.*\.dll$/i.test(entry.name)) {
          removeRuntimePath(path.join(bitsAndBytesDir, entry.name), stats)
        }
      }
    }

    if (!keepOnnxRuntimeGpu) {
      const onnxRuntimeCapiDir = path.join(sitePackages, 'onnxruntime', 'capi')
      for (const fileName of ['onnxruntime_providers_cuda.dll', 'onnxruntime_providers_tensorrt.dll']) {
        removeRuntimePath(path.join(onnxRuntimeCapiDir, fileName), stats)
      }
    }

    removeRuntimePath(path.join(sitePackages, 'torch', 'bin', 'protoc.exe'), stats)
    removeRuntimePath(path.join(sitePackages, 'torch', 'lib', 'nvperf_host.dll'), stats)
    if (!keepTorchMultiGpuSolver) {
      removeRuntimePath(path.join(sitePackages, 'torch', 'lib', 'cusolverMg64_12.dll'), stats)
    }
    if (!keepTorchNvrtcAlt) {
      removeRuntimePath(path.join(sitePackages, 'torch', 'lib', 'nvrtc64_130_0.alt.dll'), stats)
    }

    if (!keepUvInstaller) {
      for (const fileName of ['uv.exe', 'uvw.exe', 'uvx.exe']) {
        removeRuntimePath(path.join(pythonDir, 'Scripts', fileName), stats)
      }

      removeRuntimePath(path.join(sitePackages, 'uv'), stats)
      for (const entry of fs.readdirSync(sitePackages, { withFileTypes: true })) {
        if (entry.isDirectory() && /^uv-.+\.dist-info$/i.test(entry.name)) {
          removeRuntimePath(path.join(sitePackages, entry.name), stats)
        }
      }
    }

    for (const redundantPath of [
      path.join(pythonDir, 'share', 'jupyter'),
      path.join(sitePackages, 'pydeck', 'nbextension'),
      path.join(sitePackages, 'comfyui_frontend_package', 'static', 'assets', 'video-BvOHf4P9.mp4'),
      path.join(sitePackages, 'selenium', 'webdriver', 'common', 'linux'),
      path.join(sitePackages, 'selenium', 'webdriver', 'common', 'macos'),
      path.join(sitePackages, 'skimage', 'data'),
      path.join(sitePackages, 'streamlit', 'static')
    ]) {
      removeRuntimePath(redundantPath, stats)
    }
  }

  const removedMiB = (stats.bytes / 1024 / 1024).toFixed(1)
  console.log(
    `[prepare-embedded-python] Pruned ${removedMiB} MiB from embedded runtime (${stats.files} files, ${stats.directories} directories)`
  )
}

function smokeTest() {
  if (skipSmoke) {
    console.log('[prepare-embedded-python] Skipping smoke test because EMBEDDED_SKIP_SMOKE=1')
    return
  }

  const mainPy = path.join(comfyDir, 'main.py')
  const result = runCapture(pythonExe(), ['-s', mainPy, '--quick-test-for-ci', '--cpu'], {
    cwd: stagingRoot
  })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`

  if (result.status !== 0) {
    throw new Error(`ComfyUI quick test failed with exit code ${result.status}`)
  }

  if (strictSmoke) {
    const failurePatterns = [
      /\(IMPORT FAILED\)/i,
      /^Cannot import .+custom nodes:/im
    ]
    const matched = failurePatterns.find((pattern) => pattern.test(output))
    if (matched) {
      throw new Error(`ComfyUI quick test output matched failure pattern: ${matched}`)
    }
  }
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('prepare-embedded-python currently builds the Windows python_embeded package only')
  }
  if (!fs.existsSync(comfyDir)) {
    throw new Error(`Missing staged ComfyUI. Run npm run prepare:embedded-staging first: ${comfyDir}`)
  }

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          pythonVersion,
          pythonZipUrl,
          getPipUrl,
          torchIndexUrl,
          llamaCppIndexUrl,
          constraints: [
            `llama-cpp-python==${llamaCppPythonVersion}`,
            `transformers==${transformersVersion}`,
            `huggingface-hub==${huggingfaceHubVersion}`,
            `decorator==${decoratorVersion}`
          ],
          requirementsMode,
          pruneRuntime,
          keepOnnxRuntimeGpu,
          keepTorchMultiGpuSolver,
          keepTorchNvrtcAlt,
          keepUvInstaller,
          comfyRequirements: path.relative(stagingRoot, path.join(comfyDir, 'requirements.txt')),
          customNodeRequirements: getCustomNodeRequirementFiles().map((filePath) =>
            path.relative(stagingRoot, filePath)
          )
        },
        null,
        2
      )
    )
    return
  }

  ensureDir(cacheRoot)
  const pythonZipPath = path.join(cacheRoot, pythonZipName)
  const getPipPath = path.join(cacheRoot, 'get-pip.py')

  await ensureDownloaded(pythonZipUrl, pythonZipPath)
  await ensureDownloaded(getPipUrl, getPipPath)

  extractPython(pythonZipPath)
  configureEmbeddedPythonPath()
  bootstrapPip(getPipPath)
  const constraintsPath = writeConstraints()
  installTorchStack()
  installRequirements(constraintsPath)
  installSmokeRuntimeExtras()
  pruneEmbeddedRuntime()
  removePythonCaches()
  smokeTest()
  removePythonCaches()

  console.log(`[prepare-embedded-python] Wrote ${pythonDir}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
