// Offline, private Windows experiment only. No production build or asset publish.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

if (process.platform !== 'win32') throw new Error('This private WIC experiment requires Windows.')
if (process.argv.length !== 2) throw new Error('This private build accepts no arguments.')

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const expectedRepo = 'D:/Desktop/MagicPot-Terrarium-Private/open/MagicPot-Terrarium'
const canonical = (value) => fs.realpathSync(value).replaceAll('\\', '/').toLowerCase()
if (canonical(repoRoot) !== canonical(expectedRepo)) throw new Error('Unexpected experiment checkout.')

const source = path.join(here, 'wicPreviewWorker.cpp')
const trashRoot = 'D:/Desktop/MagicPot-Terrarium-Private/.magicpot-trash'
if (canonical(trashRoot) !== path.resolve(trashRoot).replaceAll('\\', '/').toLowerCase()) {
  throw new Error('The private output root must not redirect elsewhere.')
}
const binDir = path.join(trashRoot, 'cpp-preview-20261111-kt2-1', 'bin')
const exe = path.join(binDir, 'wic-preview-worker.exe')
const obj = path.join(binDir, 'wicPreviewWorker.obj')
const tempDir = path.join(binDir, 'temp')

const vs = 'C:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools'
const toolVersion = fs.readFileSync(
  path.join(vs, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'), 'utf8'
).trim()
if (!/^[0-9]+(?:\.[0-9]+)+$/.test(toolVersion)) throw new Error('Unexpected installed MSVC version.')
const msvc = path.join(vs, 'VC/Tools/MSVC', toolVersion)
const compilerDir = path.join(msvc, 'bin/Hostx64/x64')
const compiler = path.join(compilerDir, 'cl.exe')
const sdk = 'C:/Program Files (x86)/Windows Kits/10'
const sdkVersion = '10.0.26100.0'
const include = [
  path.join(msvc, 'include'),
  path.join(sdk, 'Include', sdkVersion, 'ucrt'),
  path.join(sdk, 'Include', sdkVersion, 'shared'),
  path.join(sdk, 'Include', sdkVersion, 'um'),
  path.join(sdk, 'Include', sdkVersion, 'winrt')
]
const lib = [
  path.join(msvc, 'lib/x64'),
  path.join(sdk, 'Lib', sdkVersion, 'ucrt/x64'),
  path.join(sdk, 'Lib', sdkVersion, 'um/x64')
]
for (const item of [
  source, compiler, path.join(compilerDir, 'link.exe'), ...include, ...lib,
  path.join(sdk, 'Include', sdkVersion, 'um/wincodec.h'),
  path.join(sdk, 'Lib', sdkVersion, 'um/x64/windowscodecs.lib'),
  path.join(sdk, 'Lib', sdkVersion, 'um/x64/ole32.lib'),
  path.join(sdk, 'Lib', sdkVersion, 'um/x64/psapi.lib')
]) {
  if (!fs.existsSync(item)) throw new Error('Missing already-installed build input: ' + item)
}
fs.mkdirSync(tempDir, { recursive: true })
if (canonical(binDir) !== path.resolve(binDir).replaceAll('\\', '/').toLowerCase() ||
    canonical(tempDir) !== path.resolve(tempDir).replaceAll('\\', '/').toLowerCase()) {
  throw new Error('The experiment output must stay in its private directory.')
}
for (const output of [exe, obj]) {
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) {
    throw new Error('Refusing a redirected build output.')
  }
}
const env = { ...process.env, INCLUDE: include.join(';'), LIB: lib.join(';') }
for (const key of Object.keys(env)) {
  if (/^(path|temp|tmp|cl|_cl_)$/i.test(key)) delete env[key]
}
env.PATH = compilerDir + ';' + (process.env.PATH ?? process.env.Path ?? '')
env.TEMP = tempDir
env.TMP = tempDir

const started = performance.now()
const result = spawnSync(compiler, [
  '/nologo', '/utf-8', '/std:c++17', '/EHsc', '/O2', '/MT', '/W4', '/WX',
  source, '/Fo' + obj, '/Fe' + exe,
  '/link', '/INCREMENTAL:NO', 'windowscodecs.lib', 'ole32.lib', 'psapi.lib'
], { cwd: binDir, env, windowsHide: true, shell: false, timeout: 120_000, maxBuffer: 1024 * 1024 })
if (result.stdout?.length) process.stdout.write(result.stdout)
if (result.stderr?.length) process.stderr.write(result.stderr)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const receipt = {
  ok: true, compiler, toolVersion, sdkVersion, source, exe, obj,
  elapsed_ms: Number((performance.now() - started).toFixed(3)),
  exe_bytes: fs.statSync(exe).size
}
fs.writeFileSync(path.join(binDir, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
process.stdout.write(JSON.stringify(receipt) + '\n')
