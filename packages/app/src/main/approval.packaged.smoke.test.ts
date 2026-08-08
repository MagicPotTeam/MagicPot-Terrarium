import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    } catch {
      // Windows may briefly retain Electron runtime temp-file handles after shutdown.
    }
  }
})

describe('packaged MagicAgent approval flow', () => {
  it.runIf(process.env['MAGICPOT_PACKAGED_APP_DIR'])(
    'executes only after renderer approval',
    async () => {
      const appDir = path.resolve(process.env['MAGICPOT_PACKAGED_APP_DIR']!)
      const executable = path.join(appDir, 'magicpot.exe')
      expect(existsSync(executable)).toBe(true)

      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'magicpot-approval-e2e-'))
      tempRoots.push(tempRoot)
      const markerPath = path.join(tempRoot, 'result.json')
      const userDataDir = path.join(tempRoot, 'user-data')
      mkdirSync(userDataDir, { recursive: true })

      const app = await electron.launch({
        executablePath: executable,
        args: [`--user-data-dir=${userDataDir}`],
        env: {
          ...process.env,
          MAGICPOT_USER_DATA_DIR: userDataDir,
          MAGICPOT_APPROVAL_SMOKE: '1',
          MAGICPOT_APPROVAL_SMOKE_MARKER: markerPath,
          MAGICPOT_MAGICAGENT_PLATFORM: '1',
          MAGICPOT_DISABLE_SINGLE_INSTANCE_LOCK: '1',
          MAGICPOT_DISABLE_AUTO_UPDATER: '1',
          MAGICPOT_DISABLE_PYTHON_SIDECAR: '1',
          MAGICPOT_DISABLE_SKILL_WATCHER: '1',
          MAGICPOT_TEST_AUTOMATED_RUN: '1',
          MAGICPOT_TEST_UI_MODE: 'offscreen',
          MAGICPOT_TEST_NO_FOCUS: '1',
          MAGICPOT_TEST_WINDOW_MODE: 'offscreen',
          MAGICPOT_TEST_SUPPRESS_TASKBAR: '1'
        }
      })

      let approvalPage: Page | undefined
      try {
        const firstWindow = await app.firstWindow({ timeout: 60_000 })
        await new Promise((resolve) => setTimeout(resolve, 4_000))
        for (let attempt = 0; attempt < 60 && !approvalPage; attempt += 1) {
          for (const candidate of app.windows()) {
            const approvalTitle = candidate.getByText('Agent action requires approval')
            const approveButton = candidate.getByRole('button', { name: 'Approve' })
            if ((await approvalTitle.count()) > 0 && (await approveButton.isEnabled())) {
              const pending = await candidate.evaluate(async () => {
                return await (
                  window as typeof window & {
                    api: {
                      svcMagicAgentPlatform: {
                        listPendingApprovals: (input: object) => Promise<{
                          approvals: Array<{ approvalId: string; revision: number }>
                        }>
                      }
                    }
                  }
                ).api.svcMagicAgentPlatform.listPendingApprovals({})
              })
              const approval = pending.approvals[0]
              if (!approval) continue
              await new Promise((resolve) => setTimeout(resolve, 250))
              const refreshed = await candidate.evaluate(async () => {
                return await (
                  window as typeof window & {
                    api: {
                      svcMagicAgentPlatform: {
                        listPendingApprovals: (input: object) => Promise<{
                          approvals: Array<{ approvalId: string; revision: number }>
                        }>
                      }
                    }
                  }
                ).api.svcMagicAgentPlatform.listPendingApprovals({})
              })
              const currentApproval = refreshed.approvals[0]
              if (!currentApproval) continue
              await candidate
                .evaluate(async (resolvedApproval) => {
                  await (
                    window as typeof window & {
                      api: {
                        svcMagicAgentPlatform: {
                          resolvePendingApproval: (input: {
                            approvalId: string
                            expectedRevision: number
                            approved: boolean
                          }) => Promise<unknown>
                        }
                      }
                    }
                  ).api.svcMagicAgentPlatform.resolvePendingApproval({
                    approvalId: resolvedApproval.approvalId,
                    expectedRevision: 0,
                    approved: true
                  })
                }, currentApproval)
                .catch((error) => {
                  if (!/Target page, context or browser has been closed/.test(String(error)))
                    throw error
                })
              approvalPage = candidate
              break
            }
          }
          if (!approvalPage) await new Promise((resolve) => setTimeout(resolve, 1_000))
        }
        if (!approvalPage) {
          throw new Error(
            `Approval UI not found. Windows: ${JSON.stringify(
              await Promise.all(
                app.windows().map(async (candidate) => ({
                  url: candidate.url(),
                  text: (
                    await candidate
                      .locator('body')
                      .innerText()
                      .catch(() => '')
                  ).slice(0, 500)
                }))
              )
            )}`
          )
        }
        expect(approvalPage).toBeTruthy()
        const stagePath = `${markerPath}.stage`
        await expect.poll(() => existsSync(stagePath), { timeout: 90_000 }).toBe(true)
        await expect.poll(() => existsSync(markerPath), { timeout: 90_000 }).toBe(true)
        const approvalMarker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
          authorizationId?: string
          error?: string
          exitCode?: number | null
          stdout?: string
          status: string
        }
        expect(approvalMarker.status, JSON.stringify(approvalMarker)).toBe('completed')
        expect(approvalMarker.authorizationId).toBeTruthy()
        expect(approvalMarker.exitCode).toBe(0)
        expect(approvalMarker.stdout?.trim()).toBe('magic-agent-policy-smoke')
      } finally {
        await app.close()
      }
    },
    180_000
  )
})
