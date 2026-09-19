import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it, vi } from 'vitest'

const workflowPath = path.resolve(process.cwd(), '.github/workflows/nightly-bump-version.yml')
const { mkdtempSync, readFileSync, rmSync } =
  await vi.importActual<typeof import('node:fs')>('node:fs')
const workflow = parse(readFileSync(workflowPath, 'utf8')) as {
  concurrency?: {
    group?: string
    'cancel-in-progress'?: boolean
  }
  jobs: Record<
    string,
    { needs?: string | string[]; steps?: { id?: string; run?: string }[] } | undefined
  >
}

// Execute the real decision step with offline command fixtures. This catches
// branch-order regressions that a YAML string assertion cannot detect.
const decisionScript = workflow.jobs['check-commits']?.steps?.find(
  (step) => step.id === 'check-commits'
)?.run
const commandFixtures = `
git() {
  if [ "$1" = log ] && [[ " $* " == *" --format=%H "* ]]; then
    printf '%s\\n' "$TEST_RELEASE_COMMIT"
  elif [ "$1" = log ] && [[ " $* " == *" --format=%s "* ]]; then
    printf '%s\\n' "$TEST_RELEASE_SUBJECT"
  elif [ "$1" = rev-list ] && [ "$2" = --count ]; then
    if [ "$TEST_GIT_FAILURE" = true ]; then return 1; fi
    printf '%s\\n' "$TEST_NEW_COMMITS"
  elif [ "$1" = log ] && [ "$2" = --oneline ]; then
    for ((i=0; i<TEST_NEW_COMMITS; i++)); do printf 'new-commit-%s\\n' "$i"; done
  else
    printf 'unexpected git invocation: %s\\n' "$*" >&2
    return 1
  fi
}
node() { printf '%s\\n' "$TEST_PACKAGE_VERSION"; }
gh() {
  printf 'release lookup\\n' >> "$TEST_LOOKUPS"
  if [ "$TEST_RELEASE_STATE" = missing ]; then return 1; fi
  printf '{"isDraft":false,"assetNames":[]}\\n'
}
jq() {
  cat > /dev/null
  if [ "$2" = .isDraft ]; then
    if [ "$TEST_RELEASE_STATE" = draft ]; then printf true; else printf false; fi
  elif [[ "$2" == *assetNames* ]]; then
    if [ "$TEST_RELEASE_STATE" = legacy ]; then printf 'embedded .7z, timestamped setup.exe'; fi
  else
    printf 'unexpected jq invocation\\n' >&2
    return 1
  fi
}
`

function decideNightly({
  commits = 0,
  release = 'complete',
  version = '1.0.117',
  releaseCommit = 'fa7b366da6fffd1aef86f1775c4e872555827227',
  gitFailure = false
}: {
  commits?: number
  release?: 'complete' | 'legacy' | 'draft' | 'missing'
  version?: string
  releaseCommit?: string
  gitFailure?: boolean
} = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'magicpot-nightly-decision-'))
  const output = path.join(temp, 'output')
  const lookups = path.join(temp, 'lookups')
  try {
    if (!decisionScript) throw new Error('Nightly decision script is missing')
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-c', commandFixtures + decisionScript],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          TEST_LOOKUPS: lookups,
          TEST_PACKAGE_VERSION: version,
          TEST_RELEASE_COMMIT: releaseCommit,
          TEST_RELEASE_SUBJECT: 'release: Nightly Release 2026-09-13 - 1.0.117',
          TEST_NEW_COMMITS: String(commits),
          TEST_RELEASE_STATE: release,
          TEST_GIT_FAILURE: String(gitFailure)
        }
      }
    )
    if (result.error) throw result.error
    const readOptional = (file: string) => {
      try {
        return readFileSync(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      }
    }
    return {
      status: result.status,
      stderr: result.stderr,
      output: readOptional(output),
      queriedRelease: readOptional(lookups).length > 0
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

describe('nightly bump workflow', () => {
  it.each(['legacy', 'draft', 'missing', 'complete'] as const)(
    'builds new master commits instead of retrying the %s previous release',
    (release) => {
      const result = decideNightly({ commits: 4, release })
      expect(result.status, result.stderr).toBe(0)
      expect(result.output).toBe('release_mode=bump\n')
      expect(result.queriedRelease).toBe(false)
    }
  )

  it.each(['legacy', 'draft', 'missing'] as const)(
    'preserves exact-source retry for a %s release when master has no new commits',
    (release) => {
      const result = decideNightly({ release })
      expect(result.status, result.stderr).toBe(0)
      expect(result.output).toContain('release_mode=retry\n')
      expect(result.output).toContain('tag_name=nightly-20260913-1.0.117\n')
      expect(result.output).toContain('ref=fa7b366da6fffd1aef86f1775c4e872555827227\n')
    }
  )

  it('skips a complete release only when there are no new commits', () => {
    const result = decideNightly()
    expect(result.status, result.stderr).toBe(0)
    expect(result.output).toBe('release_mode=skip\n')
  })

  it('keeps initial-release behavior when no release commit exists', () => {
    const result = decideNightly({ releaseCommit: '' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.output).toBe('release_mode=initial\n')
    expect(result.queriedRelease).toBe(false)
  })

  it('keeps initial-release behavior when the package version does not match', () => {
    const result = decideNightly({ version: '1.0.118', commits: 4, release: 'legacy' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.output).toBe('release_mode=initial\n')
  })

  it('fails closed when checking new commits fails', () => {
    const result = decideNightly({ gitFailure: true })
    expect(result.status).not.toBe(0)
    expect(result.output).toBe('')
    expect(result.queriedRelease).toBe(false)
  })

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
})
