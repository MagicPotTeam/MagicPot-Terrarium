import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProceduralSkillSettings } from './ProceduralSkillSettings'
import type { ProceduralSkillOptions } from '@shared/api/agentThreadSkill'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const Harness = ({ spy, initial }: { spy: (value: ProceduralSkillOptions) => void; initial?: ProceduralSkillOptions }) => {
  const [value, setValue] = React.useState(initial)
  return <ProceduralSkillSettings value={value} onChange={(next) => { spy(next); setValue(next) }} />
}
describe('procedural skill opt-in', () => {
  it('defaults off, warns about disclosure, and saves only explicit opt-in', () => {
    const spy = vi.fn(); render(<Harness spy={spy} />)
    const toggle = screen.getByRole('switch')
    expect((toggle as HTMLInputElement).checked).toBe(false)
    expect(screen.getByRole('alert').textContent).toContain('procedural_notice')
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
    expect(spy).not.toHaveBeenCalled(); fireEvent.click(toggle)
    expect(spy).toHaveBeenLastCalledWith({ enabled: true, paths: [] })
  })
  it('saves supported patterns on blur and refuses an invalid traversal edit', () => {
    const spy = vi.fn(); render(<Harness spy={spy} initial={{ enabled: true, paths: ['*.ts'] }} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '*.pdf\n**/todo.md' } }); fireEvent.blur(input)
    expect(spy).toHaveBeenLastCalledWith({ enabled: true, paths: ['*.pdf', '**/todo.md'] })
    spy.mockClear(); fireEvent.change(input, { target: { value: '../secret' } }); fireEvent.blur(input)
    expect(input.getAttribute('aria-invalid')).toBe('true'); expect(spy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch'))
    expect(spy).toHaveBeenCalledWith({ enabled: false, paths: ['*.pdf', '**/todo.md'] })
  })
})
