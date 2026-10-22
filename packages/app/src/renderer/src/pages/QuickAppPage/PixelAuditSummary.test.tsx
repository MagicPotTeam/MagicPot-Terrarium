import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  figPluginPixelAuditSchema,
  summarizePixelTargets,
  type FigPluginPixelTarget
} from '@shared/figplugin/pixelAudit'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'
import PixelAuditSummary from './PixelAuditSummary'
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key + (values ? ` ${JSON.stringify(values)}` : '')
  })
}))
afterEach(cleanup)
const report = (targets: FigPluginPixelTarget[]) =>
  figPluginPixelAuditSchema.parse({
    policy: 'rgba8-exact-v1',
    baselineId: 'a'.repeat(32),
    baselineEvidenceSha256: 'b'.repeat(64),
    visualEvidenceSha256: 'c'.repeat(64),
    checkedAt: 1000,
    targets,
    ...summarizePixelTargets(targets)
  })
it('absence never renders a pass', () => {
  render(<PixelAuditSummary />)
  expect(screen.getByText('figplugin.pixelAudit.pending')).toBeInTheDocument()
  expect(screen.queryByTestId('figplugin-pixel-audit')).not.toBeInTheDocument()
})
it('renders exact metrics, percentages and exported-pixel location, without action controls', () => {
  render(
    <PixelAuditSummary
      audit={report([
        {
          targetId: 'owned',
          status: 'compared',
          pixelCount: 12,
          changedPixels: 1,
          maxChannelDelta: 10,
          absoluteDelta: 10,
          changedBounds: { x: 2, y: 1, width: 1, height: 1 }
        }
      ])}
    />
  )
  expect(screen.getByTestId('figplugin-pixel-audit')).toHaveTextContent(
    'figplugin.pixelAudit.different'
  )
  expect(screen.getByTestId('figplugin-pixel-audit')).toHaveTextContent('8.333')
  expect(screen.getByTestId('figplugin-pixel-audit')).toHaveTextContent('"x":2')
  expect(screen.getByTestId('figplugin-pixel-audit')).toHaveTextContent(
    'figplugin.pixelAudit.boundary'
  )
  expect(screen.queryAllByRole('button')).toHaveLength(0)
})
it('an unavailable target stays incomplete even when other targets match', () => {
  render(
    <PixelAuditSummary
      audit={report([
        {
          targetId: 'owned',
          status: 'compared',
          pixelCount: 1,
          changedPixels: 0,
          maxChannelDelta: 0,
          absoluteDelta: 0,
          changedBounds: null
        },
        { targetId: 'missing', status: 'unavailable' }
      ])}
    />
  )
  expect(screen.getByTestId('figplugin-pixel-audit')).toHaveTextContent(
    'figplugin.pixelAudit.incomplete'
  )
  expect(screen.getByTestId('figplugin-pixel-audit')).not.toHaveTextContent(
    'figplugin.pixelAudit.match'
  )
})
it('dimension change and untrusted labels render as plain text, never HTML', () => {
  render(
    <PixelAuditSummary
      audit={report([{ targetId: '<img src=x onerror=alert(1)>', status: 'dimensions-changed' }])}
    />
  )
  expect(screen.getByTestId('figplugin-pixel-audit')).toHaveTextContent(
    'figplugin.pixelAudit.dimensions'
  )
  expect(document.querySelector('img,script')).toBeNull()
})
it('English and Chinese contain the same keys and explain bounded pixels, unavailable evidence and no write permission', () => {
  expect(Object.keys(en.figplugin.pixelAudit).sort()).toEqual(
    Object.keys(zh.figplugin.pixelAudit).sort()
  )
  expect(en.figplugin.pixelAudit.boundary).toMatch(
    /512.*original-resolution.*No automatic correction/
  )
  expect(zh.figplugin.pixelAudit.boundary).toMatch(/512.*原始分辨率.*不自动修正/)
  expect(zh.figplugin.pixelAudit.incomplete).toContain('不能判为通过')
})
