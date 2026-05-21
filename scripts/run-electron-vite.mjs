import { spawn } from 'node:child_process'
import path from 'node:path'

const DEV_USER_DATA_DIRNAME = '.aiengineelectron-dev'
const userDataDir = path.join(process.cwd(), DEV_USER_DATA_DIRNAME)
const userDataArgPrefix = '--user-data-dir='
const [command = 'dev', ...commandArgs] = process.argv.slice(2)

if (!['dev', 'preview'].includes(command)) {
  throw new Error(`Unsupported electron-vite command: ${command}`)
}

function readElectronCliArgs() {
  const raw = process.env.ELECTRON_CLI_ARGS
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch (error) {
    throw new Error(
      `Invalid ELECTRON_CLI_ARGS JSON: ${error instanceof Error ? error.message : error}`
    )
  }
}

const electronCliArgs = readElectronCliArgs().filter((arg) => !arg.startsWith(userDataArgPrefix))
electronCliArgs.unshift(`${userDataArgPrefix}${userDataDir}`)

const env = {
  ...process.env,
  ELECTRON_CLI_ARGS: JSON.stringify(electronCliArgs)
}

const electronViteBin = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
)

const args = [
  command,
  '--config',
  'config/electron/electron.vite.config.ts',
  ...(command === 'dev' ? ['-w'] : []),
  ...commandArgs
]

const child = spawn(electronViteBin, args, {
  env,
  shell: process.platform === 'win32',
  stdio: 'inherit'
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
