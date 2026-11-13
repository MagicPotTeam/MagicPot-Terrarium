import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ManagementBundledCreativeDeclarations from './ManagementBundledCreativeDeclarations'

// Test-only module replacement. Production reads no wire/user data and its actual rows are frozen.
const hostile = vi.hoisted(() => ({ name: '<img src=x onerror="window.DECLARATION_INJECTED=1">', category: '<svg onload="window.DECLARATION_INJECTED=1">', description: '<script>window.DECLARATION_INJECTED=1</script>' }))
vi.mock('@shared/magicAgentRuntime/bundledCreativeDeclarations', () => ({ bundledCreativeDeclarations: Object.freeze({ fixture: Object.freeze(hostile) }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }))
afterEach(cleanup)

describe('bundled declarations render ordinary React text, never markup', () => {
  it('keeps HTML-like name/category/description hidden until click then inert without event handlers', () => {
    const { container } = render(<MemoryRouter><ManagementBundledCreativeDeclarations /></MemoryRouter>)
    for (const value of Object.values(hostile)) expect(screen.queryByText(value)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show bundled declarations' }))
    expect(screen.getByText(hostile.name)).toBeInTheDocument()
    expect(screen.getByText('Category: ' + hostile.category)).toBeInTheDocument()
    expect(screen.getByText(hostile.description)).toBeInTheDocument()
    expect(container.querySelector('img,svg,script,a,input,textarea')).toBeNull()
    expect(Reflect.get(window, 'DECLARATION_INJECTED')).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Hide bundled declarations' }))
    for (const value of Object.values(hostile)) expect(screen.queryByText(value)).toBeNull()
  })
})
