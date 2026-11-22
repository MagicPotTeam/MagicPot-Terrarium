import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import StudioExecutionPreparation from './StudioExecutionPreparation'

// Translated with the locale files; the first test reads the zh-CN copy.
const i18nState = vi.hoisted(() => ({ language: 'zh-CN' }))
vi.mock('react-i18next', async () => {
  const { localeTranslator } = await import('@renderer/testUtils/localeTranslator')
  return { useTranslation: () => ({ t: localeTranslator(i18nState.language), i18n: { language: i18nState.language } }) }
})

describe('execution preparation notes', () => {
  it('requires a label and displays preparation without connecting or persisting', () => {
    const view = render(<StudioExecutionPreparation />)
    try {
      expect(screen.getByRole('button', { name: 'Show preparation checklist' })).toBeDisabled()
      fireEvent.change(screen.getByLabelText('Non-secret target label'), { target: { value: 'fixture host' } })
      fireEvent.click(screen.getByRole('button', { name: 'Show preparation checklist' }))
      expect(screen.getByText('fixture host')).toBeVisible()
      expect(screen.getByText('核对主机与密钥')).toBeVisible()
      expect(screen.getByText('请勿填写密钥或密码')).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'Validate offline preparation' }))
      expect(screen.getByText('Invalid preparation fields.')).toBeVisible()
      fireEvent.change(screen.getByLabelText('SSH hostname'), { target: { value: 'fixture.example' } })
      fireEvent.change(screen.getByLabelText('SSH user'), { target: { value: 'fixture' } })
      fireEvent.change(screen.getByLabelText('Pinned host key SHA256'), { target: { value: `SHA256:${'A'.repeat(43)}` } })
      fireEvent.click(screen.getByRole('button', { name: 'Validate offline preparation' }))
      expect(screen.getByText(/"executionEnabled": false/)).toHaveTextContent('"verified": false')
      fireEvent.change(screen.getByLabelText('SSH hostname'), { target: { value: '-oProxyCommand=never' } })
      expect(screen.queryByText(/"executionEnabled": false/)).toBeNull()
    } finally { view.unmount() }
  })

  it('shows English notes and checklists in en-US without Chinese text or raw keys', () => {
    i18nState.language = 'en-US'
    const view = render(<StudioExecutionPreparation />)
    try {
      fireEvent.change(screen.getByLabelText('Non-secret target label'), { target: { value: 'fixture host' } })
      fireEvent.click(screen.getByRole('button', { name: 'Show preparation checklist' }))
      expect(screen.getByText('Do not enter keys or passwords')).toBeVisible()
      expect(screen.getByText('Check the host and key')).toBeVisible()
      expect(view.container.textContent).not.toMatch(/[\u3400-\u9fff]|agent_management\./)
    } finally { view.unmount(); i18nState.language = 'zh-CN' }
  })
})
