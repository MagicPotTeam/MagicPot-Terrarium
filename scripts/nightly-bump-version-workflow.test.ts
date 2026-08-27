import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it, vi } from 'vitest'

const workflowPath = path.resolve(process.cwd(), '.github/workflows/nightly-bump-version.yml')
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
const workflow = parse(readFileSync(workflowPath, 'utf8')) as {
  jobs: Record<string, { needs?: string | string[] } | undefined>
}

describe('nightly bump workflow', () => {
  it('validates the bumped candidate without repeating master CI and build', () => {
    expect(workflow.jobs.ci).toBeUndefined()
    expect(workflow.jobs.build).toBeUndefined()
    expect(workflow.jobs['bump-version']?.needs).toBe('check-commits')
    expect(workflow.jobs['candidate-ci']?.needs).toBe('bump-version')
    expect(workflow.jobs['candidate-build']?.needs).toBe('bump-version')
  })
})
