import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const benchmark = fileURLToPath(new URL('./realBoardBenchmark.mjs', import.meta.url))

const requiredEnvironment = {
  // The corpus is intentionally supplied by the operator; never invent or reuse a path.
  // Set MAGICPOT_REAL_BOARD_IMAGE_DIR or MAGICPOT_REAL_BOARD_IMAGE_DIRS before invoking this script.
  MAGICPOT_REAL_BOARD_MODE: 'mixed',
  MAGICPOT_REAL_BOARD_IMAGE_COUNT: '3000',
  MAGICPOT_REAL_BOARD_PRESSURE_DURATION_MS: '30000',
  MAGICPOT_REAL_BOARD_CACHE_PASSES: 'cold-cache,warm-cache',
  MAGICPOT_REAL_BOARD_IMPORT_BATCH_SIZE: '128',
  MAGICPOT_REAL_BOARD_IMPORT_BATCH_SETTLE_MS: '500',
  MAGICPOT_REAL_BOARD_IMPORT_BATCH_WAIT_METRICS: 'true',
  MAGICPOT_BENCHMARK_MEMORY_WATCHDOG: '1',
  MAGICPOT_BENCHMARK_MEMORY_SOFT_LIMIT_FRACTION: '0.75',
  MAGICPOT_BENCHMARK_MEMORY_HARD_LIMIT_FRACTION: '0.8',
  MAGICPOT_REAL_BOARD_ALLOW_REPEAT: '0'
}

const environment = { ...process.env }
for (const [key, value] of Object.entries(requiredEnvironment)) {
  environment[key] = value
}

const missingCorpus = !(
  `${environment.MAGICPOT_REAL_BOARD_IMAGE_DIR || ''}`.trim() ||
  `${environment.MAGICPOT_REAL_BOARD_IMAGE_DIRS || ''}`.trim()
)
if (missingCorpus) {
  console.error(
    '[Project Canvas] Official benchmark requires MAGICPOT_REAL_BOARD_IMAGE_DIR or MAGICPOT_REAL_BOARD_IMAGE_DIRS.'
  )
  process.exitCode = 2
} else {
  const child = spawn(process.execPath, [benchmark], {
    cwd: root,
    env: environment,
    stdio: 'inherit'
  })

  child.on('error', (error) => {
    console.error(`[Project Canvas] Failed to launch official benchmark: ${error.message}`)
    process.exitCode = 1
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`[Project Canvas] Official benchmark terminated by ${signal}.`)
      process.exitCode = 1
      return
    }
    process.exitCode = code ?? 1
  })
}
