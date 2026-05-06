import { defineConfig } from 'vitest/config'
import webConfig from './vitest.web.config.mjs'

const HEAVY_WEB_TESTS = [
  'packages/app/src/renderer/src/pages/QuickAppPage/QAppDesignPanel/QAppDesignPanel.test.tsx',
  'packages/app/src/renderer/src/pages/QuickAppPage/CustomSkillManagerPage.test.tsx',
  'packages/app/src/renderer/src/pages/SettingsPage/PanelPlugin.test.tsx',
  'packages/app/src/renderer/src/pages/SettingsPage/PanelLLM.test.tsx',
  'packages/app/src/renderer/src/pages/ChatPage/ChatPage.agentSkill.test.tsx',
  'packages/app/src/renderer/src/components/ImageCanvas/components/ImageEditPanel/ImageEditPanel.test.tsx',
  'packages/app/src/renderer/src/components/ImageCanvas/ImageViewer.test.tsx',
  'packages/app/src/renderer/src/components/SidePanel.test.tsx',
  'packages/app/src/renderer/src/pages/QuickAppPage/components/QAppContext.test.tsx'
]

export default defineConfig({
  ...webConfig,
  test: {
    ...webConfig.test,
    pool: 'forks',
    fileParallelism: false,
    poolOptions: {
      forks: {
        singleFork: true
      }
    },
    exclude: [...(webConfig.test.exclude ?? []), ...HEAVY_WEB_TESTS]
  }
})
