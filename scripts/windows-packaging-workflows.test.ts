import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
const root = process.cwd()
const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts as Record<
  string,
  string
>

type Workflow = { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> }
const cases = [
  {
    file: 'call-embedded-candidate.yml',
    job: 'validate-windows-embedded',
    step: 'Build embedded candidate',
    mode: 'embedded'
  },
  {
    file: 'call-release.yml',
    job: 'release-windows',
    step: 'Build embedded package',
    mode: 'embedded'
  },
  { file: 'call-release.yml', job: 'release-windows', step: 'Build pure package', mode: 'pure' }
]

// Public Actions used to call electron-builder directly, skipping package:win's
// bridge child build. A green app build did not imply a complete packaged app.
describe('Windows release packaging entrypoints', () => {
  it.each(cases)(
    '$file / $step uses the complete package entrypoint without publishing early',
    ({ file, job, step, mode }) => {
      const workflow = parse(
        readFileSync(path.join(root, '.github/workflows', file), 'utf8')
      ) as Workflow
      const command = workflow.jobs[job].steps.find((item) => item.name === step)?.run
      expect(command).toBeTypeOf('string')
      if (!command) throw new Error(`Missing packaging step: ${file} / ${step}`)
      const packageCommand = 'npm run package:win -- --publish never'
      const packageIndex = command.indexOf(packageCommand)
      expect(packageIndex).toBeGreaterThan(-1)
      expect(command.match(/npm run package:win/g)).toHaveLength(1)
      expect(command).not.toMatch(/\bnpx\s+electron-builder\b/)
      for (const prerequisite of [
        `npm run build:${mode}`,
        'npm run build:image-worker',
        `$env:PACKAGE_MODE = '${mode}'`,
        'Remove-Item Env:GH_TOKEN',
        'Remove-Item Env:GITHUB_TOKEN',
        ...(mode === 'embedded' ? ['npm run prepare:embedded'] : [])
      ]) {
        const index = command.indexOf(prerequisite)
        expect(index, prerequisite).toBeGreaterThan(-1)
        expect(index, prerequisite).toBeLessThan(packageIndex)
      }
    }
  )

  it('builds all package-only workers before invoking electron-builder and propagates failures', () => {
    const stages = scripts['package:win'].split(' && ')
    expect(stages).toEqual([
      'npm run build:magicpot-command-job',
      'npm run build:bridge-child',
      'npm run build:document-worker',
      'electron-builder --config config/electron/electron-builder.config.js --win --x64'
    ])
    expect(scripts['build:bridge-child']).toBe('node scripts/build-bridge-child.mjs')
  })

  it('keeps local Pure and Embedded release commands on that same packaging path', () => {
    for (const mode of ['pure', 'embedded']) {
      expect(scripts[`release:${mode}:win`]).toContain(
        `cross-env PACKAGE_MODE=${mode} npm run package:win`
      )
    }
  })
})
