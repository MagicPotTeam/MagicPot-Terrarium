// Private experiment builder. Source product files and installed output are not edited.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const privateRoot = path.resolve(repoRoot, '../../.magicpot-trash')
const inside = (parent, child) => {
  const value = path.relative(parent, child)
  return (
    value !== '' && value !== '..' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value)
  )
}

export async function buildIsolatedCppPreview(runRoot) {
  if (!path.isAbsolute(runRoot) || !inside(privateRoot, runRoot))
    throw Error('Use a new private experiment root')
  const appRoot = path.join(runRoot, 'app')
  await fs.mkdir(appRoot, { recursive: false })
  const emptyEnvDir = path.join(appRoot, 'empty-env')
  await fs.mkdir(emptyEnvDir)
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  await fs.writeFile(
    path.join(appRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'magicpot-isolated-image-acceptance',
        version: pkg.version,
        main: 'bootstrap.cjs',
        type: 'commonjs',
        dependencies: pkg.dependencies,
        devDependencies: { electron: pkg.devDependencies.electron }
      },
      null,
      2
    ),
    { flag: 'wx' }
  )
  await fs.symlink(
    path.join(repoRoot, 'node_modules'),
    path.join(appRoot, 'node_modules'),
    'junction'
  )
  const fromApp = (value) =>
    path.relative(appRoot, path.join(repoRoot, value)).split(path.sep).join('/')
  const configFile = path.join(appRoot, 'isolated.electron.config.mjs')
  await fs.writeFile(
    configFile,
    [
      'import config from ' +
        JSON.stringify(fromApp('config/electron/electron.vite.config.ts')) +
        ';',
      'import { createIsolatedCppPreviewPlugin } from ' +
        JSON.stringify(fromApp('scripts/chat/native/isolatedCppPreviewTransform.mjs')) +
        ';',
      'for (const target of ["main", "preload", "renderer"]) {',
      '  config[target].envDir = ' + JSON.stringify(emptyEnvDir) + ';',
      '  config[target].cacheDir = ' +
        JSON.stringify(path.join(appRoot, 'cache')) +
        ' + "/" + target;',
      '  config[target].define = { ...config[target].define,',
      '    "import.meta.env.VITE_BUILD_MODE": JSON.stringify("pure"),',
      '    "import.meta.env.VITE_PACKAGE_MODE": JSON.stringify("pure"),',
      '    "import.meta.env.VITE_BUILD_MODE_NAME": JSON.stringify("Pure"),',
      '    "import.meta.env.VITE_MAGICPOT_AUTO_START_COMFYUI": JSON.stringify("false")',
      '  };',
      '}',
      'config.renderer.plugins = [...(config.renderer.plugins || []), createIsolatedCppPreviewPlugin()];',
      'export default config;',
      ''
    ].join('\n'),
    { flag: 'wx' }
  )
  process.chdir(repoRoot)
  const { build } = await import('electron-vite')
  await build({
    root: appRoot,
    configFile,
    mode: 'pure',
    envFile: false,
    build: { outDir: path.join(appRoot, 'out'), emptyOutDir: true }
  })
  for (const entry of ['main/index.js', 'preload/index.js', 'renderer/index.html'])
    await fs.access(path.join(appRoot, 'out', entry))
  return { runRoot, appRoot }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw Error('Pass a new private run root')
  console.log(
    'isolated-cpp-preview-build',
    JSON.stringify(await buildIsolatedCppPreview(path.resolve(process.argv[2])))
  )
}
