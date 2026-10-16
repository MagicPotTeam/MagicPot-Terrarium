import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it, vi } from 'vitest'

const workflowPath = path.resolve(process.cwd(), '.github/workflows/nightly-bump-version.yml')
const releaseWorkflowPath = path.resolve(process.cwd(), '.github/workflows/call-release.yml')
const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
const workflow = parse(readFileSync(workflowPath, 'utf8')) as {
  concurrency?: {
    group?: string
    'cancel-in-progress'?: boolean
  }
  jobs: Record<string, { needs?: string | string[]; with?: Record<string, unknown> } | undefined>
}
const releaseWorkflow = parse(readFileSync(releaseWorkflowPath, 'utf8')) as {
  on?: { workflow_call?: { inputs?: Record<string, { default?: unknown; type?: string }> } }
  jobs: Record<string, { steps?: Array<{ name?: string; if?: string }> } | undefined>
}

describe('nightly bump workflow', () => {
  it('serializes runs that share the release branch', () => {
    expect(workflow.concurrency).toEqual({
      group: 'nightly-bump-version',
      'cancel-in-progress': false
    })
  })

  it('validates the bumped candidate without repeating master CI and build', () => {
    expect(workflow.jobs.ci).toBeUndefined()
    expect(workflow.jobs.build).toBeUndefined()
    expect(workflow.jobs['bump-version']?.needs).toBe('check-commits')
    expect(workflow.jobs['candidate-ci']?.needs).toBe('bump-version')
    expect(workflow.jobs['candidate-build']?.needs).toBe('bump-version')
  })

  it('routes incomplete retries to existing-release repair without reusing create metadata', () => {
    const retryJob = workflow.jobs['release-existing']
    expect(retryJob?.with?.update_release_metadata).toBe(
      '${{ needs.check-commits.outputs.update_release_metadata }}'
    )
    const checkSource = readFileSync(workflowPath, 'utf8')
    expect(checkSource).toContain('echo "update_release_metadata=false"')
    expect(releaseWorkflow.on?.workflow_call?.inputs?.update_release_metadata).toMatchObject({
      type: 'boolean',
      default: true
    })
    const releaseSteps = releaseWorkflow.jobs['release-windows']?.steps ?? []
    expect(
      releaseSteps.find((step) => step.name === 'Stage and verify Windows release')?.if
    ).toContain('inputs.update_release_metadata')
    expect(
      releaseSteps.find((step) => step.name === 'Upload assets to existing release')?.if
    ).toContain('!inputs.update_release_metadata')
  })
})
