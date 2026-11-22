import { defineConfig } from 'vitest/config'
import webConfig from './vitest.web.config.mjs'

// Channel real-page test bed: the real ChatPage on in-memory fakes, with the network, real
// IndexedDB, workers and every unlisted desktop bridge call refused and counted.
//
//   npm run test:web:channel
//   (npx vitest run --config config/vitest/vitest.web.channel.config.mjs)
//
// The deny guards are the FIRST setup file, so they are in place before the test file and any
// business module it imports are loaded. These files are excluded from vitest.web.config.mjs
// (and therefore from the light shards) with the same pattern: they must never run without the
// guards, and the existing web suite stays exactly as it was.
const CHANNEL_REAL_PAGE_TESTS = 'packages/app/src/renderer/**/*.channel.realPage.test.{ts,tsx}'

export default defineConfig({
  ...webConfig,
  test: {
    ...webConfig.test,
    name: 'web-channel',
    include: [CHANNEL_REAL_PAGE_TESTS],
    exclude: (webConfig.test.exclude ?? []).filter(
      (pattern) => pattern !== CHANNEL_REAL_PAGE_TESTS
    ),
    setupFiles: [
      'packages/app/src/renderer/src/test/channelDenyGuards.ts',
      ...(webConfig.test.setupFiles ?? [])
    ],
    // The bed depends on both orders, so they are pinned instead of left to the defaults:
    // setup files run one after the other in the order listed (guards first), and afterEach
    // hooks run in reverse order of registration (the guards' end-of-test check runs last,
    // after the test file's hooks and Testing Library's unmount).
    sequence: {
      ...webConfig.test.sequence,
      setupFiles: 'list',
      hooks: 'stack'
    }
  }
})
