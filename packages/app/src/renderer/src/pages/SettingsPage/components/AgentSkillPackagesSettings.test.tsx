import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import AgentSkillPackagesSettings from './AgentSkillPackagesSettings'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/components/inputs/InputPath', () => ({ default: ({ value, onChange, label }: { value: string; onChange(value: string): void; label: string }) => <input aria-label={label} value={value} onChange={event => onChange(event.target.value)} /> }))
afterEach(cleanup)
describe('explicit passive Markdown directory registry settings', () => {
  it('defaults to none, adds disabled entries and saves only a registration without execution flags', async () => {
    const save = vi.fn(); render(<AgentSkillPackagesSettings settingsValue={DEFAULT_CONFIG} saveSettings={save} />)
    expect(save).not.toHaveBeenCalled(); expect(screen.queryAllByRole('switch')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'environment.agent_skill_packages.add' }))
    expect(screen.getByRole('switch', { name: 'environment.agent_skill_packages.enable' })).not.toBeChecked(); expect(save).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('environment.agent_skill_packages.directory'), { target: { value: 'D:/user/skill-documents' } })
    fireEvent.change(screen.getByLabelText('environment.agent_skill_packages.project'), { target: { value: 'project-one' } })
    fireEvent.click(screen.getByRole('switch', { name: 'environment.agent_skill_packages.enable' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'environment.agent_skill_packages.save' })))
    expect(save).toHaveBeenCalledExactlyOnceWith({ llm_config: { proceduralSkillPackages: [{ id: expect.any(String), directory: 'D:/user/skill-documents', enabled: true, projectId: 'project-one' }] } })
    expect(screen.getByText('environment.agent_skill_packages.submitted')).toBeTruthy()
  })
  it('rejects enabled relative/network directories and invalid project IDs; removal changes no disk files', async () => {
    const save = vi.fn(), config = structuredClone(DEFAULT_CONFIG)
    config.llm_config.proceduralSkillPackages = [{ id: 'one', directory: 'relative', enabled: true }]
    render(<AgentSkillPackagesSettings settingsValue={config} saveSettings={save} />)
    const button = screen.getByRole('button', { name: 'environment.agent_skill_packages.save' })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText('environment.agent_skill_packages.directory'), { target: { value: '\\\\remote\\share' } }); expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText('environment.agent_skill_packages.directory'), { target: { value: 'D:/valid' } }); expect(button).not.toBeDisabled()
    fireEvent.change(screen.getByLabelText('environment.agent_skill_packages.project'), { target: { value: '../foreign' } }); expect(button).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'environment.agent_skill_packages.remove' })); await act(async () => fireEvent.click(button))
    expect(save).toHaveBeenCalledWith({ llm_config: { proceduralSkillPackages: [] } })
  })
  it('offers manifest mode only in existing settings, resets enable and saves no execution or install flags', async () => {
    const save = vi.fn(), config = structuredClone(DEFAULT_CONFIG)
    config.llm_config.proceduralSkillPackages = [{ id: 'one', directory: 'D:/selected-package', enabled: true, projectId: 'owned' }]
    const { unmount } = render(<AgentSkillPackagesSettings settingsValue={config} saveSettings={save} />)
    const manifest = screen.getByRole('switch', { name: 'environment.agent_skill_packages.manifest' }), enabled = screen.getByRole('switch', { name: 'environment.agent_skill_packages.enable' })
    expect(manifest).not.toBeChecked(); expect(enabled).toBeChecked()
    fireEvent.click(manifest)
    expect(manifest).toBeChecked(); expect(enabled).not.toBeChecked(); expect(save).not.toHaveBeenCalled()
    expect(screen.getByText('environment.agent_skill_packages.manifest_help')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'environment.agent_skill_packages.save' })))
    expect(save).toHaveBeenLastCalledWith({ llm_config: { proceduralSkillPackages: [{ id: 'one', directory: 'D:/selected-package', enabled: false, projectId: 'owned', source: 'manifest' }] } })
    fireEvent.click(enabled)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'environment.agent_skill_packages.save' })))
    expect(save.mock.calls.at(-1)![0].llm_config.proceduralSkillPackages[0]).toMatchObject({ source: 'manifest', enabled: true })
    fireEvent.click(manifest); expect(enabled).not.toBeChecked()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'environment.agent_skill_packages.save' })))
    expect(save.mock.calls.at(-1)![0].llm_config.proceduralSkillPackages[0]).toMatchObject({ source: 'directory', enabled: false })
    unmount()
    const last = save.mock.calls.at(-2)![0].llm_config.proceduralSkillPackages
    render(<AgentSkillPackagesSettings settingsValue={{ ...config, llm_config: { ...config.llm_config, proceduralSkillPackages: last } }} saveSettings={save} />)
    expect(screen.getByRole('switch', { name: 'environment.agent_skill_packages.manifest' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'environment.agent_skill_packages.enable' })).toBeChecked()
    expect(save).toHaveBeenCalledTimes(3)
  })
  it('waits for persistence, surfaces rejection for disable/removal, and can retry without unhandled failure', async () => {
    let reject!: (error: Error) => void
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail })).mockResolvedValue(undefined)
    const config = structuredClone(DEFAULT_CONFIG); config.llm_config.proceduralSkillPackages = [{ id: 'enabled', directory: 'D:/skills', enabled: true }]
    const view = render(<AgentSkillPackagesSettings settingsValue={config} saveSettings={save} />)
    fireEvent.click(screen.getByRole('switch', { name: 'environment.agent_skill_packages.enable' })); fireEvent.click(screen.getByRole('button', { name: 'environment.agent_skill_packages.save' }))
    expect(screen.queryByText('environment.agent_skill_packages.submitted')).toBeNull()
    expect(screen.getByRole('button', { name: 'environment.agent_skill_packages.save' })).toBeDisabled()
    await act(async () => reject(new Error('disk denied')))
    expect(screen.getByText('environment.agent_skill_packages.failed')).toBeTruthy(); expect(screen.queryByText('environment.agent_skill_packages.submitted')).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'environment.agent_skill_packages.save' })))
    expect(save).toHaveBeenCalledTimes(2); expect(save.mock.calls[1][0].llm_config.proceduralSkillPackages[0].enabled).toBe(false)
    expect(screen.getByText('environment.agent_skill_packages.submitted')).toBeTruthy()
    view.unmount()
  })
  it('caps the explicit registry without automatically enabling any added path', () => {
    const config = structuredClone(DEFAULT_CONFIG); config.llm_config.proceduralSkillPackages = Array.from({ length: 16 }, (_, i) => ({ id: `entry${i}`, directory: '', enabled: false }))
    render(<AgentSkillPackagesSettings settingsValue={config} saveSettings={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'environment.agent_skill_packages.add' })).toBeDisabled()
    expect(screen.getAllByRole('switch').every(element => !(element as HTMLInputElement).checked)).toBe(true)
  })
})
