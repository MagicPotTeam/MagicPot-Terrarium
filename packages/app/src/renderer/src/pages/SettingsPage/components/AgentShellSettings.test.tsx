import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { deepMerge, type DeepPartial } from '@shared/utils/utilTypes'
import AgentShellSettings from './AgentShellSettings'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const Harness = ({ spy }: { spy: (patch: DeepPartial<Config>) => void }) => {
  const [config, setConfig] = React.useState(structuredClone(DEFAULT_CONFIG))
  return <AgentShellSettings settingsValue={config} saveSettings={(patch) => { spy(patch); setConfig((old) => deepMerge(old as never, patch as never) as Config) }} />
}
describe('independent general shell configuration', () => {
  it('defaults off, displays host-code warning and does not turn on Python/read-only terminal', () => {
    const spy = vi.fn(); render(<Harness spy={spy} />)
    expect(screen.getByRole('switch', { name: 'environment.agent_shell.enable' })).not.toBeChecked(); expect(spy).not.toHaveBeenCalled()
    expect(screen.getByText('environment.agent_shell.warning')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'environment.agent_shell.enable' }))
    expect(spy).toHaveBeenLastCalledWith({ project_trace_config: expect.objectContaining({ enable_agent_shell: true, enable_agent_python_notebook: false, enable_agent_terminal: false }) })
  })
  it('keeps snapshot saving independent from execution and never initializes or saves on opt-in', () => {
    const spy = vi.fn(); render(<Harness spy={spy} />)
    expect(screen.getByRole('switch', { name: 'environment.agent_html.save_enable' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('switch', { name: 'environment.agent_html.save_enable' }))
    expect(spy).toHaveBeenLastCalledWith({ project_trace_config: expect.objectContaining({ enable_agent_html_save: true, enable_agent_html_apps: false, enable_agent_shell: false, enable_agent_python_notebook: false, enable_agent_terminal: false }) })
    expect(screen.getByText('environment.agent_html.save_warning')).toBeTruthy()
  })
  it('persists a literal absolute path and an explicit shell kind without launching or probing', () => {
    const spy = vi.fn(); render(<Harness spy={spy} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bash' } })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'C:/trusted/bash.exe' } })
    expect(spy).toHaveBeenLastCalledWith({ project_trace_config: expect.objectContaining({ agent_shell_kind: 'bash', agent_shell_executable: 'C:/trusted/bash.exe', enable_agent_shell: false }) })
  })
})
