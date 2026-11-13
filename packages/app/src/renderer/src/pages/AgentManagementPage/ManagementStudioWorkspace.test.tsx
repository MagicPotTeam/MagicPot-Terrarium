import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { createStudioCreatureBundle, emptyStudioWorkspace, parseStudioWorkspaceText, studioWorkspaceSchema } from '@shared/studioWorkspace'
import AgentManagementPage from './AgentManagementPage'

const h = vi.hoisted(() => ({ save: vi.fn(async (_value: unknown) => {}), navigate: vi.fn(), dispatch: vi.fn(), api: vi.fn((): never => { throw new Error('No service read') }) }))
let config: Config
const location = Object.freeze({ pathname: '/agent-management', search: '', hash: '', key: 'studio', state: null })
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ config, isReady: true, updateConfig: h.save }) }))
vi.mock('@renderer/store', () => ({ useAppDispatch: () => h.dispatch }))
vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate, useLocation: () => location }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string) => key }) }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: h.api }))
const secret = 'PRIVATE_KEY_NOT_EXPORTED'
const existing = () => ({ version: 1 as const, creatures: [{ id: 'one', name: 'First', modelProfileId: 'model-id', systemPrompt: 'Be helpful' }], nodes: [{ id: 'local', name: 'Local', address: 'http://127.0.0.1:9000' }] })
const change = (label: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } })
function open() {
  render(<AgentManagementPage />)
  fireEvent.click(screen.getByRole('button', { name: 'Open Studio workspace' }))
}
async function upload(value: unknown) {
  const file = new File([JSON.stringify(value)], 'studio.json', { type: 'application/json' })
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify(value) })
  await act(async () => { fireEvent.change(screen.getByLabelText('Studio JSON file'), { target: { files: [file] } }) })
}
beforeEach(() => {
  vi.clearAllMocks()
  config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.api_profiles = [{ id: 'model-id', model_name: 'Test model', api_key: secret, base_url: 'PRIVATE_ENDPOINT', auth_account_email: 'configured@example.test' }]
  h.save.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Studio basic workspace', () => {
  it('keeps mount passive, then saves/edits/deletes creature and node metadata through the existing config path', async () => {
    render(<AgentManagementPage />)
    expect(h.save).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Creature ID')).toBeNull()
    expect(screen.queryByText(/configured@example.test/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open Studio workspace' }))
    change('Creature ID', 'new'); change('Creature name', 'New creature'); change('System prompt', 'Local prompt')
    expect(h.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save creature' }))
    await screen.findByRole('button', { name: 'Edit creature new' })
    expect(h.save).toHaveBeenLastCalledWith({ studio_workspace: { version: 1, creatures: [{ id: 'new', name: 'New creature', modelProfileId: '', systemPrompt: 'Local prompt' }], nodes: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Edit creature new' }))
    change('Creature name', 'Edited')
    fireEvent.click(screen.getByRole('button', { name: 'Save creature' }))
    await waitFor(() => expect(screen.getByText(/Edited · new/)).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: 'Delete creature new' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit creature new' })).toBeNull())
    change('Node ID', 'n1'); change('Node name', 'Target'); change('Node address (no credentials)', 'ssh://example.test')
    fireEvent.click(screen.getByRole('button', { name: 'Save node' }))
    await screen.findByRole('button', { name: 'Edit node n1' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit node n1' })); change('Node name', 'Renamed target')
    fireEvent.click(screen.getByRole('button', { name: 'Save node' }))
    await waitFor(() => expect(screen.getByText(/Renamed target · n1/)).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: 'Delete node n1' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit node n1' })).toBeNull())
    expect(h.save).toHaveBeenLastCalledWith({ studio_workspace: emptyStudioWorkspace() })
    expect(document.body.innerHTML).not.toContain(secret)
    expect(h.api).not.toHaveBeenCalled()
  })

  it('exposes only configured unverified account labels and hands off to existing plugin/skill destinations on click', () => {
    open()
    expect(screen.getByText(/configured@example.test/)).toHaveTextContent('(unverified)')
    expect(screen.getByRole('heading',{name:'Model and account labels / 模型与账号标记'})).toBeVisible()
    expect(document.body.innerHTML).not.toContain(secret)
    expect(document.body.innerHTML).not.toContain('PRIVATE_ENDPOINT')
    fireEvent.click(screen.getByRole('button', { name: 'Open plugin center' }))
    expect(h.navigate).toHaveBeenLastCalledWith('/workshop/plugins', { state: null })
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'layout/openTab', payload: { id: 'tab-workshop-plugins', label: 'Plugins', routePath: '/workshop/plugins', closable: true } })
    fireEvent.click(screen.getByRole('button', { name: 'Open custom-skill manager' }))
    expect(h.navigate).toHaveBeenLastCalledWith('/custom-skill-manager', { state: null })
    expect(h.save).not.toHaveBeenCalled(); expect(h.api).not.toHaveBeenCalled()
  })

  it('exports only Studio data and restores only after confirmation; invalid files never save', async () => {
    config.studio_workspace = existing()
    const blobs: Blob[] = []
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(value: Blob) { blobs.push(value); return 'blob:studio-test' }
      static revokeObjectURL() { return undefined }
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Export Studio JSON' }))
    expect(click).toHaveBeenCalledOnce()
    expect(blobs).toHaveLength(1)
    const exported = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blobs[0])
    })
    expect(parseStudioWorkspaceText(exported)).toEqual(existing())
    expect(exported).not.toContain(secret); expect(exported).not.toContain('configured@example.test')
    await upload({ ...existing(), api_key: secret })
    expect(screen.getByText('Invalid Studio JSON. Existing data was not changed.')).toBeVisible()
    expect(h.save).not.toHaveBeenCalled()
    await upload(emptyStudioWorkspace())
    expect(screen.getByText(/Replace with 0 creature templates and 0 nodes/)).toBeVisible()
    expect(h.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel restore' }))
    expect(h.save).not.toHaveBeenCalled()
    await upload(emptyStudioWorkspace())
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Studio restore' }))
    await waitFor(() => expect(h.save).toHaveBeenCalledExactlyOnceWith({ studio_workspace: emptyStudioWorkspace() }))
    expect(h.api).not.toHaveBeenCalled()
  })

  it('exports a selected manual node bundle without credentials, network, Start or permission fields', async () => {
    config.studio_workspace = existing()
    const create = vi.fn(() => 'blob:bundle-test')
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL() { return undefined } })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    open()
    expect(screen.getByRole('button', { name: 'Export deployment bundle' })).toBeDisabled()
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Bundle creature' }))
    fireEvent.click(screen.getByRole('option', { name: 'First' }))
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Target node' }))
    fireEvent.click(screen.getByRole('option', { name: 'Local' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export deployment bundle' }))
    expect(create).toHaveBeenCalledOnce()
    expect(screen.getByText('Bundle download requested.')).toBeVisible()
    const bundle = createStudioCreatureBundle(existing(), 'one', 'local')
    expect(bundle).toEqual({ format: 'magicpot-studio-creature-bundle', version: 1, creature: existing().creatures[0], target: existing().nodes[0], delivery: 'manual', start: false })
    expect(JSON.stringify(bundle)).not.toMatch(/api_key|token|permission|PRIVATE/)
    expect(h.api).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled()
  })

  it('rejects unknown fields, duplicate IDs, credential-bearing node URLs and oversized restores', () => {
    for (const bad of [
      { ...existing(), token: secret },
      { ...existing(), creatures: [existing().creatures[0], existing().creatures[0]] },
      { ...existing(), nodes: [{ ...existing().nodes[0], address: 'https://user:secret@example.test' }] },
      { ...existing(), nodes: [{ ...existing().nodes[0], address: 'https://example.test/?token=secret' }] },
      { ...existing(), creatures: [{ ...existing().creatures[0], tools: ['bash'] }] }
    ]) expect(studioWorkspaceSchema.safeParse(bad).success).toBe(false)
    expect(() => parseStudioWorkspaceText(' '.repeat(1024 * 1024 + 1))).toThrow('Studio file exceeds 1 MiB.')
    expect(() => createStudioCreatureBundle(existing(), 'missing', 'local')).toThrow('Choose an existing creature and target node.')
  })
})
