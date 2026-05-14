import os from 'os'
import path from 'path'
import { defineConfig } from 'vitest/config'
import nodeConfig from './vitest.node.config.mjs'

const goalTrashDir =
  process.env.MAGICPOT_GOAL_TRASH || path.join(os.homedir(), 'Desktop', 'MagicPot-goal-trash')

const coreFrameworkSources = [
  'packages/app/src/shared/agent/capabilityRegistry.ts',
  'packages/app/src/shared/agent/sessionIdentity.ts',
  'packages/app/src/shared/agent/subagentRegistry.ts',
  'packages/app/src/shared/agent/subagentOrchestrator.ts',
  'packages/app/src/shared/agent/toolContracts.ts',
  'packages/app/src/shared/api/apiUtils/abortHandler.ts',
  'packages/app/src/shared/api/apiUtils/streaming.ts',
  'packages/app/src/shared/api/createClient/createIpcClient.ts',
  'packages/app/src/shared/api/createServer/registerIpcServer.ts',
  'packages/app/src/preload/apiIpc.ts',
  'packages/app/src/main/agentKernel/agentKernel.ts',
  'packages/app/src/main/agentKernel/runtime.ts',
  'packages/app/src/main/agentKernel/toolBridge.ts'
]

export default defineConfig({
  ...nodeConfig,
  test: {
    ...nodeConfig.test,
    include: [
      'packages/app/src/shared/agent/**/*.test.ts',
      'packages/app/src/shared/api/apiUtils/**/*.test.ts',
      'packages/app/src/shared/api/createClient/**/*.test.ts',
      'packages/app/src/shared/api/createServer/**/*.test.ts',
      'packages/app/src/preload/apiIpc.test.ts',
      'packages/app/src/main/agentKernel/**/*.test.ts'
    ],
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: path.join(goalTrashDir, 'coverage-core'),
      include: coreFrameworkSources,
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      }
    }
  }
})
