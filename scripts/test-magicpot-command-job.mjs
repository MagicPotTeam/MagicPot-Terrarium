import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.log('Skipping magicpot-command-job behavioral tests: Windows is required.')
  process.exit(0)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const helper = path.join(
  root,
  'packages',
  'runtime-assets',
  'resources',
  'bin',
  'magicpot-command-job',
  'magicpot-command-job.exe'
)
if (!existsSync(helper)) throw new Error(`Missing Windows command-job helper: ${helper}`)

const run = (limits, source, timeout = 15_000) => {
  const started = Date.now()
  const result = spawnSync(helper, [...limits, '--', process.execPath, '-e', source], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout
  })
  return { ...result, elapsedMs: Date.now() - started }
}

const expectedArgv = [
  'plain',
  '',
  'space value',
  'quote"value',
  'slash'.concat(String.fromCharCode(92, 92), '"value'),
  'trailing' + String.fromCharCode(92),
  'Unicode-\u53c2\u6570-\ud83d\ude80'
]
const argvResult = spawnSync(
  helper,
  [
    '-',
    '-',
    '1',
    '--',
    process.execPath,
    '-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
    ...expectedArgv
  ],
  { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }
)
if (
  argvResult.error ||
  argvResult.status !== 0 ||
  argvResult.stdout !== JSON.stringify(expectedArgv)
) {
  throw new Error(`Windows argv fidelity failed: ${JSON.stringify(argvResult)}`)
}

const cpu = run(['-', '200', '1'], 'while(true){}')
if (cpu.error || cpu.status === 0 || cpu.elapsedMs >= 15_000)
  throw new Error(`CPU limit failed: ${JSON.stringify(cpu)}`)

const processCount = run(
  ['-', '-', '1'],
  `const {spawn}=require('node:child_process');try{spawn(process.execPath,['-e','setTimeout(()=>{},5000)']);process.exit(41)}catch(error){process.exit(error && error.code === 'UNKNOWN' ? 0 : 42)}`
)
if (processCount.error || processCount.status !== 0)
  throw new Error(`Process-count limit failed: ${JSON.stringify(processCount)}`)

const memory = run(
  [String(48 * 1024 * 1024), '-', '1'],
  `const held=[];setInterval(()=>held.push(Buffer.alloc(4*1024*1024,1)),5)`,
  20_000
)
if (memory.error || memory.status === 0)
  throw new Error(`Memory limit failed: ${JSON.stringify(memory)}`)

const descendantMarker = '__MAGICPOT_DESCENDANT_PID__'
const tree = spawn(
  helper,
  [
    '-',
    '-',
    '4',
    '--',
    process.execPath,
    '-e',
    `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});console.log('${descendantMarker}'+child.pid);setTimeout(()=>{},60000)`
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
)
let output = ''
const descendantPid = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Descendant PID timeout: ${output}`)), 15_000)
  tree.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8')
    const match = output.match(new RegExp(`${descendantMarker}(\\d+)`))
    if (match) {
      clearTimeout(timeout)
      resolve(Number(match[1]))
    }
  })
  tree.once('error', reject)
})
tree.kill()
await new Promise((resolve) => tree.once('close', resolve))
await new Promise((resolve) => setTimeout(resolve, 500))
const tasklist = spawnSync(
  'tasklist.exe',
  ['/FI', `PID eq ${descendantPid}`, '/FO', 'CSV', '/NH'],
  {
    encoding: 'utf8'
  }
)
if (tasklist.error || tasklist.stdout.includes(`"${descendantPid}"`))
  throw new Error(`Kill-on-close failed: ${JSON.stringify({ descendantPid, tasklist })}`)

console.log(
  JSON.stringify({
    argv: { preserved: true, cases: expectedArgv.length },
    cpu: { status: cpu.status, elapsedMs: cpu.elapsedMs },
    processCount: { status: processCount.status },
    memory: { status: memory.status },
    killOnClose: { descendantPid, terminated: true }
  })
)
