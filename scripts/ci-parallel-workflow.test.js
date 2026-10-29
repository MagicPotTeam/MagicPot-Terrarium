import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
const root = fileURLToPath(new URL('../', import.meta.url))
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const workflow = parse(read('.github/workflows/call-ci.yml'))
const pullRequest = parse(read('.github/workflows/ci-on-pull-request.yml'))
const scripts = JSON.parse(read('package.json')).scripts

// Compare the real command leaves, not a hand-maintained list of test counts.
// New scripts added to `npm run test` must also be assigned to the matrix.
function expand(command, ancestors = []) {
  return command.split(' && ').flatMap((part) => {
    const match = /^npm run ([\w:-]+)$/.exec(part.trim())
    if (!match) return [part.trim()]
    const name = match[1]
    if (!scripts[name] || ancestors.includes(name)) throw new Error(`Invalid test script: ${name}`)
    return expand(scripts[name], [...ancestors, name])
  })
}

function bashExecutable() {
  if (process.platform !== 'win32') return 'bash'
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' })
  if (git.status !== 0) throw new Error('Git for Windows is required for shell regressions')
  let directory = git.stdout.trim()
  while (path.dirname(directory) !== directory) {
    const found = ['bin/bash.exe', 'usr/bin/bash.exe']
      .map((relative) => path.join(directory, relative))
      .find((candidate) => fs.existsSync(candidate))
    if (found) return found
    directory = path.dirname(directory)
  }
  throw new Error('Git for Windows Bash was not found')
}

const outcomes = ['success', 'failure', 'skipped', 'cancelled']

describe('parallel CI preserves the complete existing validation contract', () => {
  it('assigns every original test command exactly once without changing its options', () => {
    const groups = workflow.jobs.tests.strategy.matrix.include
    expect(groups).toHaveLength(7)
    expect(new Set(groups.map((group) => group.group)).size).toBe(groups.length)
    expect(groups.flatMap((group) => expand(group.command)).sort()).toEqual(
      expand('npm run test').sort()
    )
    expect(workflow.jobs.tests.steps.find((step) => step.name === 'Test').run).toBe(
      '${{ matrix.command }}'
    )
    expect(workflow.jobs.tests.strategy['fail-fast']).toBe(false)
    expect(workflow.jobs.tests.strategy['max-parallel']).toBe(7)
    expect(workflow.jobs.tests).not.toHaveProperty('needs')
    expect(workflow.jobs.quality).not.toHaveProperty('needs')
  })

  it('retains all three light shards, all nine isolated heavy scripts and the full node suite', () => {
    const commands = workflow.jobs.tests.strategy.matrix.include.flatMap((group) =>
      group.command.split(' && ')
    )
    expect(commands).toContain('npm run test:node')
    for (let shard = 1; shard <= 3; shard++) {
      expect(
        commands.filter((command) => command === `npm run test:web:light:${shard}`)
      ).toHaveLength(1)
      expect(scripts[`test:web:light:${shard}`]).toContain(`--shard=${shard}/3`)
    }
    const heavy = Object.keys(scripts).filter((name) => name.startsWith('test:web:heavy:'))
    expect(heavy).toHaveLength(9)
    for (const script of heavy) {
      expect(commands.filter((command) => command === `npm run ${script}`)).toHaveLength(1)
      expect(scripts[script]).toContain('NODE_OPTIONS=--max-old-space-size=6144')
    }
  })

  it('retains audit, host preparation, lint, types, benchmark smoke and security posture', () => {
    const steps = workflow.jobs.quality.steps
    for (const command of [
      'npm audit --omit=dev',
      'node --test scripts/prepare-figplugin-host.test.mjs',
      'npm run lint',
      'npm run typecheck',
      'npm run test:project-canvas:benchmark-smoke',
      'npm run qa:security-posture'
    ]) {
      const matching = steps.filter((step) => step.run === command)
      expect(matching).toHaveLength(1)
      expect(matching[0]).not.toHaveProperty('if')
    }
    for (const job of Object.values(workflow.jobs)) {
      expect(job).not.toHaveProperty('continue-on-error')
      for (const step of job.steps) expect(step).not.toHaveProperty('continue-on-error')
    }
  })

  it('keeps the existing required check as an unconditional, fail-closed aggregate', () => {
    const gate = workflow.jobs['test-lint-typecheck']
    expect(gate).not.toHaveProperty('name')
    expect(gate.if).toBe('${{ always() }}')
    expect([...gate.needs].sort()).toEqual(['quality', 'tests'])
    expect(gate.steps).toHaveLength(1)
    expect(gate.steps[0].env).toEqual({
      TESTS_RESULT: '${{ needs.tests.result }}',
      QUALITY_RESULT: '${{ needs.quality.result }}'
    })
    expect(gate.steps[0]).not.toHaveProperty('if')
    expect(gate.steps[0].shell).toBe('bash')
  })

  it.each(outcomes.flatMap((tests) => outcomes.map((quality) => ({ tests, quality }))))(
    'executes the real required gate for tests=$tests and quality=$quality',
    ({ tests, quality }) => {
      const result = spawnSync(
        bashExecutable(),
        ['--noprofile', '--norc', '-c', workflow.jobs['test-lint-typecheck'].steps[0].run],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: { ...process.env, TESTS_RESULT: tests, QUALITY_RESULT: quality }
        }
      )
      if (result.error) throw result.error
      expect(result.status === 0, result.stderr).toBe(tests === 'success' && quality === 'success')
    }
  )

  it('only supersedes old runs for the same PR, not manual, master or release runs', () => {
    expect(pullRequest.concurrency).toEqual({
      group: '${{ github.workflow }}-pr-${{ github.event.pull_request.number || github.run_id }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}"
    })
    expect(workflow).not.toHaveProperty('concurrency')
    const master = parse(read('.github/workflows/ci-on-master.yml'))
    expect(master).not.toHaveProperty('concurrency')
    const nightly = parse(read('.github/workflows/nightly-bump-version.yml'))
    expect(nightly.concurrency['cancel-in-progress']).toBe(false)
    expect(pullRequest.on).not.toHaveProperty('pull_request_target')
    expect(pullRequest.permissions).toEqual({})
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })
})
