/* eslint-disable @typescript-eslint/explicit-function-return-type */
import fs from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  buildNonIntrusiveTestWindowEnv,
  resolveProjectCanvasArtifactRoot,
  resolveProjectCanvasBenchmarkRunId
} from './benchmarkPolicy.mjs'

const execFileAsync = promisify(execFile)

const RUN_ID = resolveProjectCanvasBenchmarkRunId('dev-watcher-probe')
const ARTIFACT_ROOT = resolveProjectCanvasArtifactRoot(RUN_ID)
const PROBE_ROOT = path.join(ARTIFACT_ROOT, 'watch-probe')
const READY_WAIT_MS = Math.max(
  5000,
  Number.parseInt(process.env.MAGICPOT_DEV_WATCHER_PROBE_READY_MS || '45000', 10) || 45000
)
const OBSERVE_MS = Math.max(
  3000,
  Number.parseInt(process.env.MAGICPOT_DEV_WATCHER_PROBE_OBSERVE_MS || '15000', 10) || 15000
)
const PROCESS_CLEANUP_TIMEOUT_MS = Math.max(
  2000,
  Number.parseInt(process.env.MAGICPOT_BENCHMARK_PROCESS_CLEANUP_TIMEOUT_MS || '10000', 10) ||
    10000
)

const WATCH_EVENT_PATTERN =
  /\b(hmr update|page reload|reload|restart|restarting|rebuild|rebuilt|build started|building|changed|change detected|trigger renderer reload|restart electron app|rebuild the electron)\b/i
const READY_PATTERN = /(dev server running|renderer.*localhost|local:\s+http:\/\/|ready in \d+ms)/i

function toErrorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function writeProbeArtifacts(root) {
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    path.join(root, 'watch-probe-report.json'),
    JSON.stringify(
      {
        runId: RUN_ID,
        generatedAt: new Date().toISOString(),
  purpose: 'Confirm .magicpot-trash writes do not trigger npm run dev rebuilds.'
      },
      null,
      2
    ),
    'utf8'
  )
  await fs.writeFile(path.join(root, 'watch-probe.log'), 'watch probe log placeholder\n', 'utf8')
  await fs.writeFile(path.join(root, 'watch-probe.txt'), 'watch probe text placeholder\n', 'utf8')
  await fs.writeFile(
    path.join(root, 'watch-probe.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64'
    )
  )
}

async function stopProcessTree(processId) {
  if (!Number.isInteger(processId) || processId <= 0) {
    return
  }

  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
      timeout: PROCESS_CLEANUP_TIMEOUT_MS,
      windowsHide: true
    })
    return
  }

  try {
    process.kill(-processId, 'SIGTERM')
  } catch {
    try {
      process.kill(processId, 'SIGTERM')
    } catch {
      // Ignore best-effort cleanup failures.
    }
  }
}

function createNpmDevProcess() {
  const isWindows = process.platform === 'win32'
  const command = isWindows ? 'cmd.exe' : 'npm'
  const args = isWindows ? ['/d', '/s', '/c', 'npm run dev'] : ['run', 'dev']
  return spawn(command, args, {
    cwd: process.cwd(),
    detached: !isWindows,
    env: {
      ...process.env,
      ...buildNonIntrusiveTestWindowEnv(RUN_ID),
      MAGICPOT_TEST_AUTOMATED_RUN: '1',
      MAGICPOT_TEST_RUN_ID: RUN_ID
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
}

async function runDevWatcherProbe() {
  await fs.mkdir(PROBE_ROOT, { recursive: true })
  const stdoutPath = path.join(PROBE_ROOT, 'npm-run-dev.stdout.log')
  const stderrPath = path.join(PROBE_ROOT, 'npm-run-dev.stderr.log')
  const summaryPath = path.join(PROBE_ROOT, 'dev-watcher-probe-summary.json')
  const stdoutHandle = await fs.open(stdoutPath, 'w')
  const stderrHandle = await fs.open(stderrPath, 'w')
  let child = null
  const observedAfterProbe = []
  const outputTail = []
  let ready = false
  let probeStarted = false
  let childExit = null

  const handleOutput = async (source, chunk) => {
    const text = chunk.toString()
    try {
      if (source === 'stdout') {
        await stdoutHandle.write(text)
      } else {
        await stderrHandle.write(text)
      }
    } catch {
      // The child can flush a final chunk after cleanup starts; keep the probe result stable.
    }

    if (READY_PATTERN.test(text)) {
      ready = true
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed) {
        outputTail.push({ source, text: trimmed.slice(0, 1000) })
      }
    }
    while (outputTail.length > 40) {
      outputTail.shift()
    }
    if (probeStarted && WATCH_EVENT_PATTERN.test(text)) {
      observedAfterProbe.push({
        source,
        text: text.trim().slice(0, 1000),
        at: new Date().toISOString()
      })
    }
  }

  try {
    child = createNpmDevProcess()
    child.stdout?.on('data', (chunk) => {
      void handleOutput('stdout', chunk)
    })
    child.stderr?.on('data', (chunk) => {
      void handleOutput('stderr', chunk)
    })
    child.on('exit', (code, signal) => {
      childExit = { code, signal }
    })

    const readyDeadline = Date.now() + READY_WAIT_MS
    while (!ready && !childExit && Date.now() < readyDeadline) {
      await wait(500)
    }
    if (childExit) {
      const recentOutput = outputTail.map((entry) => entry.text).join('\n')
      const portInUse = recentOutput.match(/Port \d+ is already in use/i)?.[0]
      throw new Error(
        portInUse
          ? `npm run dev exited before readiness because ${portInUse}. See ${stderrPath}.`
          : `npm run dev exited before readiness: ${JSON.stringify(childExit)}`
      )
    }
    if (!ready) {
      throw new Error(`Timed out waiting ${READY_WAIT_MS}ms for npm run dev readiness.`)
    }

    probeStarted = true
    await writeProbeArtifacts(PROBE_ROOT)
    await wait(OBSERVE_MS)

    const failures =
      observedAfterProbe.length > 0
        ? ['npm run dev emitted rebuild/restart/HMR-like events after Desktop trash writes.']
        : childExit
          ? [`npm run dev exited during observation: ${JSON.stringify(childExit)}`]
          : []
    const summary = {
      runId: RUN_ID,
      artifactRoot: ARTIFACT_ROOT,
      probeRoot: PROBE_ROOT,
      readyWaitMs: READY_WAIT_MS,
      observeMs: OBSERVE_MS,
      observedWatchEventsAfterProbe: observedAfterProbe,
      outputTail,
      childExit,
      passed: failures.length === 0,
      failures
    }
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
    console.log(JSON.stringify(summary, null, 2))
    if (!summary.passed) {
      process.exitCode = 1
    }
  } catch (error) {
    const summary = {
      runId: RUN_ID,
      artifactRoot: ARTIFACT_ROOT,
      probeRoot: PROBE_ROOT,
      passed: false,
      outputTail,
      failures: [error instanceof Error ? error.message : String(error)]
    }
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
    await fs.writeFile(path.join(PROBE_ROOT, 'dev-watcher-probe-error.txt'), toErrorMessage(error))
    console.error(toErrorMessage(error))
    process.exitCode = 1
  } finally {
    try {
      await stopProcessTree(child?.pid)
    } catch {
      // The child may already be gone.
    }
    try {
      await stdoutHandle.close()
    } catch {
      // Ignore close failures.
    }
    try {
      await stderrHandle.close()
    } catch {
      // Ignore close failures.
    }
  }
}

await runDevWatcherProbe()
