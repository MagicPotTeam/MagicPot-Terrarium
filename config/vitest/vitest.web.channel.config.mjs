import { defineConfig } from 'vitest/config'
import webConfig from './vitest.web.config.mjs'

// Channel real-page test bed: the real ChatPage on in-memory fakes, with the network, real
// IndexedDB, workers and every unlisted desktop bridge call refused and counted.
//
//   npx vitest run --config config/vitest/vitest.web.channel.config.mjs
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
    ]
  }
})
