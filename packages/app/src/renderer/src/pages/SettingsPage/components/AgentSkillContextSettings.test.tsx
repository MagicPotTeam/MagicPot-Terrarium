import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import AgentSkillContextSettings from './AgentSkillContextSettings'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
describe('independent skill-context disclosure opt-ins', () => {
  it('defaults both off and saves only explicit metadata options, never enables directories or execution', async () => {
    const save = vi.fn(); render(<AgentSkillContextSettings settingsValue={DEFAULT_CONFIG} saveSettings={save} />)
    expect(screen.getAllByRole('switch').every(element => !(element as HTMLInputElement).checked)).toBe(true); expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('switch', { name: 'environment.agent_skill_context.index' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'environment.agent_skill_context.save' })))
    expect(save).toHaveBeenCalledExactlyOnceWith({ llm_config: { proceduralSkillContext: { index: true, paths: false } } })
    expect(screen.getByText('environment.agent_skill_context.saved')).toBeTruthy()
  })
  it('awaits and reports persistence failure without claiming previous opt-ins are disabled', async () => {
    const config = structuredClone(DEFAULT_CONFIG); config.llm_config.proceduralSkillContext = { index: true, paths: true }
    let reject!: (error: Error) => void
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail })).mockResolvedValue(undefined)
    render(<AgentSkillContextSettings settingsValue={config} saveSettings={save} />)
    fireEvent.click(screen.getByRole('switch', { name: 'environment.agent_skill_context.paths' }))
    const button = screen.getByRole('button', { name: 'environment.agent_skill_context.save' })
    fireEvent.click(button); fireEvent.click(button); expect(save).toHaveBeenCalledOnce(); expect(button).toBeDisabled()
    await act(async () => reject(new Error('disk failed')))
    expect(screen.getByText('environment.agent_skill_context.failed')).toBeTruthy(); expect(screen.queryByText('environment.agent_skill_context.saved')).toBeNull()
    await act(async () => fireEvent.click(button)); expect(save.mock.calls[1][0]).toEqual({ llm_config: { proceduralSkillContext: { index: true, paths: false } } })
  })
  it('ignores late success after unmount and keeps new mount options independent', async () => {
    let finish!: () => void
    const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const view = render(<AgentSkillContextSettings settingsValue={DEFAULT_CONFIG} saveSettings={save} />)
    fireEvent.click(screen.getByRole('button', { name: 'environment.agent_skill_context.save' })); view.unmount()
    render(<AgentSkillContextSettings settingsValue={DEFAULT_CONFIG} saveSettings={vi.fn()} />)
    await act(async () => finish()); expect(screen.queryByText('environment.agent_skill_context.saved')).toBeNull()
    expect(screen.getAllByRole('switch').every(element => !(element as HTMLInputElement).checked)).toBe(true)
  })
})
