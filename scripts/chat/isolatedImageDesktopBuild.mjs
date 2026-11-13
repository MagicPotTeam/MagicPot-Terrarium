import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const privateScratch = path.resolve(repoRoot, '../../.magicpot-trash')

function inside(parent, child) {
  const relative = path.relative(parent, child)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

/** Build the real application into a new owned directory. Does not launch it or
 * invoke any sidecar builder that copies files into release assets. */
export async function buildIsolatedImageDesktop(runRoot) {
  if (!path.isAbsolute(runRoot) || !inside(privateScratch, runRoot)) {
    throw new Error('The isolated build root must be under the private project scratch directory.')
  }
  const appRoot = path.join(runRoot, 'app')
  await fs.mkdir(appRoot, { recursive: false })
  const emptyEnvDir = path.join(appRoot, 'empty-env')
  await fs.mkdir(emptyEnvDir)
  const sourcePackage = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({
    name: 'magicpot-isolated-image-acceptance',
    version: sourcePackage.version,
    main: 'bootstrap.cjs',
    type: 'commonjs',
    dependencies: sourcePackage.dependencies,
    devDependencies: { electron: sourcePackage.devDependencies.electron }
  }, null, 2), { flag: 'wx' })
  // Dependencies are read from the existing installation; builds and application
  // data are written only under this new app/run root.
  await fs.symlink(path.join(repoRoot, 'node_modules'), path.join(appRoot, 'node_modules'), 'junction')
  const sourceConfig = path.relative(appRoot, path.join(repoRoot, 'config/electron/electron.vite.config.ts')).split(path.sep).join('/')
  const configFile = path.join(appRoot, 'isolated.electron.config.mjs')
  const configSource = [
    'import config from ' + JSON.stringify(sourceConfig) + ';',
    'for (const target of ["main", "preload", "renderer"]) {',
    '  config[target].envDir = ' + JSON.stringify(emptyEnvDir) + ';',
    '  config[target].cacheDir = ' + JSON.stringify(path.join(appRoot, 'cache')) + ' + "/" + target;',
    '  config[target].define = { ...config[target].define,',
    '    "import.meta.env.VITE_BUILD_MODE": JSON.stringify("pure"),',
    '    "import.meta.env.VITE_PACKAGE_MODE": JSON.stringify("pure"),',
    '    "import.meta.env.VITE_BUILD_MODE_NAME": JSON.stringify("Pure"),',
    '    "import.meta.env.VITE_MAGICPOT_AUTO_START_COMFYUI": JSON.stringify("false")',
    '  };',
    '}',
    'export default config;',
    ''
  ].join('\n')
  await fs.writeFile(configFile, configSource, { flag: 'wx' })
  // The source configuration resolves its inputs/aliases from the repository.
  // electron-vite receives appRoot separately, so its temporary bundled config
  // and all three output directories are outside the live repository output.
  process.chdir(repoRoot)
  const { build } = await import('electron-vite')
  await build({
    root: appRoot,
    configFile,
    mode: 'pure',
    envFile: false,
    build: { outDir: path.join(appRoot, 'out'), emptyOutDir: true }
  })
  const mainEntry = path.join(appRoot, 'out/main/index.js')
  const preload = path.join(appRoot, 'out/preload/index.js')
  const renderer = path.join(appRoot, 'out/renderer/index.html')
  await Promise.all([mainEntry, preload, renderer].map(file => fs.access(file)))
  return { runRoot, appRoot, mainEntry, preload, renderer }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const runRoot = process.argv[2]
  if (!runRoot) throw new Error('Pass one absolute, newly created isolated run root.')
  const result = await buildIsolatedImageDesktop(path.resolve(runRoot))
  console.log('isolated-image-build-complete', JSON.stringify(result))
}
