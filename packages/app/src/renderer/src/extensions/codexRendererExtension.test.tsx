import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config, LLMAPIProfile } from '@shared/config/config'
import { codexRendererExtension } from './codexRendererExtension'
import PanelLLM from '@renderer/pages/SettingsPage/PanelLLM'
import { rendererHostExtensionApiV1 } from '@renderer/extensions/generatedRegistry'
import { DEFAULT_CONFIG } from '@shared/config/config'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key
  })
}))

const textProfile: LLMAPIProfile = {
  id: 'text-only',
  model_name: 'Ordinary text',
  call_type: 'api',
  model_use: 'agent',
  base_url: 'https://text.fixture/v1',
  api_key: 'text-key-not-for-image'
}
const cardExtra = (
  profile: LLMAPIProfile,
  profiles: LLMAPIProfile[],
  onUpdate: (id: string, profile: LLMAPIProfile) => void = vi.fn(),
  isChineseUi = false
) =>
  codexRendererExtension.settings!.renderAgentApiProfileCardExtra!({
    profile,
    profiles,
    onUpdate,
    isChineseUi,
    callTypeOptions: [],
    onChangeCallType: vi.fn(),
    onClone: vi.fn(),
    onDelete: vi.fn(),
    onReplaceProfiles: vi.fn()
  })

describe('explicit image backend selection on the existing Agent profile card', () => {
  it.each([
    ['en-US', '/codex'],
    ['en-US', '/v1'],
    ['zh-CN', '/codex'],
    ['zh-CN', '/v1']
  ] as const)(
    'shows no GIF setting or dedicated caption on a %s card linked to %s',
    (locale, path) => {
      const isChineseUi = locale === 'zh-CN'
      const onUpdate = vi.fn()
      const target = { ...proxyProfile, base_url: `https://proxy.example.test${path}` }
      const profile = { ...textProfile, codex_image_profile_id: target.id }
      const { container } = render(
        <>{cardExtra(profile, [profile, target], onUpdate, isChineseUi)}</>
      )
      expect(screen.getByRole('combobox')).toHaveValue(target.id)
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
      expect(container).not.toHaveTextContent(
        /Allow GIF output for image_gen|允许 image_gen 输出 GIF/i
      )
      expect(container).not.toHaveTextContent(
        /Default off for this text profile|默认关闭，仅允许此文本配置/
      )
      expect(container).not.toHaveTextContent(/has no GIF output|不支持 GIF 输出/)
      // General approval guidance is still true and is deliberately not a GIF preference.
      expect(container).toHaveTextContent(
        isChineseUi ? /每次都须正式审批/ : /needs a fresh formal approval/
      )
      expect(onUpdate).not.toHaveBeenCalled()
    }
  )

  it('does not select or save another login merely by showing the card', () => {
    const onUpdate = vi.fn()
    render(<>{cardExtra(textProfile, [textProfile, proxyProfile], onUpdate)}</>)
    expect(screen.getByRole('combobox', { name: 'image_gen backend' })).toHaveValue('')
    expect(onUpdate).not.toHaveBeenCalled()
    expect(screen.getByText(/A plain text-to-image request runs directly/)).toBeTruthy()
    expect(
      screen.getByText(/uploads images or outputs a GIF needs a fresh formal approval/)
    ).toBeTruthy()
    expect(document.body.textContent).not.toContain('test-key')
    expect(document.body.textContent).not.toContain('text-key-not-for-image')
  })

  it('stores only the chosen backend id and supports clearing it', () => {
    const onUpdate = vi.fn()
    const Harness = () => {
      const [profile, setProfile] = React.useState(textProfile)
      return (
        <>
          {cardExtra(profile, [profile, proxyProfile], (id, next) => {
            onUpdate(id, next)
            setProfile(next)
          })}
        </>
      )
    }
    render(<Harness />)
    const select = screen.getByRole('combobox', { name: 'image_gen backend' })
    fireEvent.change(select, { target: { value: proxyProfile.id } })
    expect(onUpdate).toHaveBeenLastCalledWith('text-only', {
      ...textProfile,
      codex_image_profile_id: proxyProfile.id
    })
    fireEvent.change(select, { target: { value: '' } })
    expect(onUpdate).toHaveBeenLastCalledWith('text-only', {
      ...textProfile,
      codex_image_profile_id: undefined
    })
    expect(onUpdate).toHaveBeenCalledTimes(2)
    for (const [, updated] of onUpdate.mock.calls)
      expect(updated).not.toHaveProperty('codex_image_gif_enabled')
  })

  it('lists only unique eligible Codex backends, not public Images, stale mixed auth or duplicate ids', () => {
    const oauth = {
      ...proxyProfile,
      id: 'oauth',
      call_type: 'codex',
      auth_mode: 'codex_oauth',
      api_key: ''
    }
    const invalid = [
      { ...proxyProfile, id: 'mixed', auth_mode: 'codex_oauth' },
      { ...proxyProfile, id: 'images', model_use: 'image' as const },
      { ...proxyProfile, id: 'public-images', base_url: 'https://api.openai.com/v1' },
      { ...proxyProfile, id: 'duplicate' },
      { ...proxyProfile, id: 'duplicate' }
    ]
    render(<>{cardExtra(textProfile, [textProfile, proxyProfile, oauth, ...invalid])}</>)
    const values = screen
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value)
    expect(values).toEqual(['', 'dynamic-proxy', 'oauth'])
  })

  it('preserves a missing explicit selection visibly rather than changing credentials', () => {
    const profile = { ...textProfile, codex_image_profile_id: 'deleted-backend' }
    const onUpdate = vi.fn()
    render(<>{cardExtra(profile, [profile, proxyProfile], onUpdate)}</>)
    expect(screen.getByRole('combobox', { name: 'image_gen backend' })).toHaveValue(
      'deleted-backend'
    )
    expect(screen.getByText(/Unavailable backend/)).toBeTruthy()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('saves and clears through the real settings panel and existing extension registry', () => {
    const previous = rendererHostExtensionApiV1.settings
    rendererHostExtensionApiV1.settings = codexRendererExtension.settings
    const save = vi.fn()
    try {
      const Harness = () => {
        const [settings, setSettings] = React.useState({
          ...DEFAULT_CONFIG,
          llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [textProfile, proxyProfile] }
        })
        return (
          <PanelLLM
            settingsValue={settings}
            saveSettings={(patch) => {
              save(patch)
              if (patch.llm_config?.api_profiles)
                setSettings((current) => ({
                  ...current,
                  llm_config: {
                    ...current.llm_config,
                    api_profiles: patch.llm_config!.api_profiles as LLMAPIProfile[]
                  }
                }))
            }}
          />
        )
      }
      render(<Harness />)
      const selects = screen.getAllByRole('combobox', { name: 'image_gen backend' })
      expect(selects).toHaveLength(2)
      fireEvent.change(selects[0], { target: { value: proxyProfile.id } })
      expect(save).toHaveBeenLastCalledWith({
        llm_config: {
          api_profiles: [{ ...textProfile, codex_image_profile_id: proxyProfile.id }, proxyProfile]
        }
      })
      expect(selects[0]).toHaveValue(proxyProfile.id)
      fireEvent.change(selects[0], { target: { value: '' } })
      expect(save).toHaveBeenLastCalledWith({
        llm_config: {
          api_profiles: [{ ...textProfile, codex_image_profile_id: undefined }, proxyProfile]
        }
      })
      expect(selects[0]).toHaveValue('')
      expect(save).toHaveBeenCalledTimes(2)
      for (const [patch] of save.mock.calls) {
        for (const savedProfile of patch.llm_config.api_profiles) {
          expect(savedProfile).not.toHaveProperty('codex_image_gif_enabled')
        }
      }
      expect(screen.queryByRole('checkbox', { name: /GIF/i })).not.toBeInTheDocument()
    } finally {
      rendererHostExtensionApiV1.settings = previous
    }
  })

  it.each(['image', 'video', 'ocr'] as const)(
    'does not offer a thread backend selector on a %s profile',
    (model_use) => {
      render(<>{cardExtra({ ...textProfile, model_use }, [textProfile, proxyProfile])}</>)
      expect(screen.queryByRole('combobox', { name: 'image_gen backend' })).toBeNull()
      expect(screen.queryByRole('checkbox', { name: /GIF/i })).not.toBeInTheDocument()
    }
  )
})

const originalPathDescriptor = Object.getOwnPropertyDescriptor(window, 'path')
const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

const proxyProfile: LLMAPIProfile = {
  id: 'dynamic-proxy',
  model_name: '',
  call_type: 'cliproxyapi',
  base_url: 'https://proxy.example.test/v1',
  api_key: 'test-key'
}

describe('codexRendererExtension dynamic model discovery', () => {
  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
  })

  it.each(['cliproxyapi', 'codex'] as const)(
    'preserves the scanned model IDs and order for %s',
    async (callType) => {
      // Generated opaque IDs in deliberately non-alphabetic order; never a release catalog.
      const names = Array.from(
        { length: 32 },
        (_, index) => `test-${(index * 13) % 32}/Alias:${index}+value`
      )
      const list = vi.fn().mockResolvedValue({
        models: names.map((value) => ({
          value,
          label: value,
          source: 'remote'
        }))
      })
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { svcCodexModels: { list } }
      })
      const profile: LLMAPIProfile =
        callType === 'cliproxyapi'
          ? proxyProfile
          : { ...proxyProfile, call_type: 'codex', auth_mode: 'codex_oauth' }

      await expect(codexRendererExtension.chat?.discoverModelNames?.(profile)).resolves.toEqual(
        names
      )
      expect(list).toHaveBeenCalledWith(
        callType === 'cliproxyapi' ? { cliProxyProfileId: profile.id } : { currentModelName: '' }
      )
    }
  )

  it('does not set a hardcoded model when configuring an empty Codex profile', () => {
    const result = codexRendererExtension.settings?.applyAgentApiProfileCallType?.({
      profile: { ...proxyProfile, call_type: 'api' },
      callType: 'codex'
    })
    expect(result?.model_name).toBe('')
  })
})

describe('pending Codex authentication preserves current image settings', () => {
  afterEach(() => {
    if (originalApiDescriptor) Object.defineProperty(window, 'api', originalApiDescriptor)
    else Reflect.deleteProperty(window, 'api')
  })

  const authProfile: LLMAPIProfile = {
    id: 'auth-source',
    model_name: 'source-text',
    call_type: 'codex',
    model_use: 'agent',
    base_url: 'https://api.openai.com/v1',
    api_key: ''
  }
  const installAuth = (available: boolean) => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const login = vi.fn(async () => {
      await pending
      return { email: 'account@fixture.test', connectedAt: 1000 }
    })
    const logout = vi.fn(async () => {
      await pending
    })
    const status = vi
      .fn()
      .mockResolvedValue(
        available
          ? { available: true, mode: 'chatgpt', email: 'old@fixture.test' }
          : { available: false, mode: 'none', reason: 'missing_auth_file' }
      )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { svcCodexAuth: { status, login, logout, getUsage: vi.fn().mockResolvedValue({}) } }
    })
    return { finish, login, logout }
  }

  it.each(
    (['browser', 'local', 'logout'] as const).flatMap((mode) =>
      (['select', 'clear'] as const).map((change) => [mode, change] as const)
    )
  )(
    'pending %s preserves the %s image link and unrelated source/sibling fields through real settings save',
    async (mode, change) => {
      const auth = installAuth(mode !== 'browser')
      const source = {
        ...authProfile,
        ...(mode === 'logout'
          ? { auth_mode: 'codex_oauth', auth_account_email: 'old@fixture.test' }
          : {}),
        ...(change === 'clear' ? { codex_image_profile_id: proxyProfile.id } : {})
      }
      const sibling = { ...textProfile, id: 'sibling' }
      let saved: LLMAPIProfile[] = [source, proxyProfile, sibling]
      const save = vi.fn()
      const previous = rendererHostExtensionApiV1.settings
      rendererHostExtensionApiV1.settings = codexRendererExtension.settings
      const Harness = () => {
        const [settings, setSettings] = React.useState({
          ...DEFAULT_CONFIG,
          llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: saved }
        })
        return (
          <>
            <PanelLLM
              settingsValue={settings}
              saveSettings={(patch) => {
                save(patch)
                if (patch.llm_config?.api_profiles) {
                  saved = patch.llm_config.api_profiles as LLMAPIProfile[]
                  setSettings((current) => ({
                    ...current,
                    llm_config: { ...current.llm_config, api_profiles: saved }
                  }))
                }
              }}
            />
            <button
              onClick={() =>
                setSettings((current) => ({
                  ...current,
                  llm_config: {
                    ...current.llm_config,
                    api_profiles: current.llm_config.api_profiles.map((p) =>
                      p.id === source.id
                        ? { ...p, model_name: 'new-source-name' }
                        : p.id === sibling.id
                          ? { ...p, model_name: 'new-sibling-name' }
                          : p
                    )
                  }
                }))
              }
            >
              Edit other current fields
            </button>
          </>
        )
      }
      try {
        render(<Harness />)
        const label =
          mode === 'browser'
            ? 'Switch Account in Browser'
            : mode === 'local'
              ? 'Sync Local Codex Login'
              : 'Sign Out Local Codex Login'
        fireEvent.click(await screen.findByRole('button', { name: label }))
        expect(mode === 'logout' ? auth.logout : auth.login).toHaveBeenCalledOnce()
        if (mode !== 'logout')
          expect(auth.login).toHaveBeenCalledWith({
            mode,
            forceReauth: mode === 'browser' ? true : undefined
          })
        const select = screen.getAllByRole('combobox', { name: 'image_gen backend' })[0]
        fireEvent.change(select, { target: { value: change === 'clear' ? '' : proxyProfile.id } })
        fireEvent.click(screen.getByRole('button', { name: 'Edit other current fields' }))
        await act(async () => {
          auth.finish()
          await Promise.resolve()
        })
        await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
        expect(saved[0]).toMatchObject({
          codex_image_profile_id: change === 'clear' ? undefined : proxyProfile.id,
          model_name: 'new-source-name'
        })
        expect(saved.find((p) => p.id === sibling.id)?.model_name).toBe('new-sibling-name')
        if (mode === 'logout') expect(saved[0]).not.toHaveProperty('auth_mode')
        else
          expect(saved[0]).toMatchObject({
            auth_mode: 'codex_oauth',
            auth_account_email: 'account@fixture.test',
            auth_connected_at: 1000
          })
        expect(select).toHaveValue(change === 'clear' ? '' : proxyProfile.id)
        expect(saved[0]).not.toHaveProperty('codex_image_gif_enabled')
      } finally {
        rendererHostExtensionApiV1.settings = previous
      }
    }
  )

  it.each(
    (['login', 'logout'] as const).flatMap((mode) =>
      (['unmount', 'switch-type', 'delete', 'replace-id', 'duplicate-id'] as const).map(
        (ending) => [mode, ending] as const
      )
    )
  )('late %s cannot write after %s invalidates its exact card', async (mode, ending) => {
    const auth = installAuth(mode === 'logout')
    const onUpdate = vi.fn()
    const onReplaceProfiles = vi.fn()
    const card = (profile: LLMAPIProfile, profiles: LLMAPIProfile[]) =>
      codexRendererExtension.settings?.renderAgentApiProfileCardExtra?.({
        isChineseUi: false,
        callTypeOptions: [],
        onChangeCallType: vi.fn(),
        onClone: vi.fn(),
        onDelete: vi.fn(),
        profiles,
        profile,
        onUpdate,
        onReplaceProfiles
      })
    const { rerender, unmount } = render(<>{card(authProfile, [authProfile, proxyProfile])}</>)
    fireEvent.click(
      await screen.findByRole('button', {
        name: mode === 'login' ? 'Switch Account in Browser' : 'Sign Out Local Codex Login'
      })
    )
    expect(mode === 'login' ? auth.login : auth.logout).toHaveBeenCalledOnce()
    if (ending === 'unmount') unmount()
    else if (ending === 'switch-type')
      rerender(
        <>
          {card({ ...authProfile, call_type: 'api' }, [
            { ...authProfile, call_type: 'api' },
            proxyProfile
          ])}
        </>
      )
    else if (ending === 'delete') rerender(<>{card(authProfile, [proxyProfile])}</>)
    else if (ending === 'replace-id')
      rerender(
        <>
          {card({ ...authProfile, id: 'other' }, [{ ...authProfile, id: 'other' }, proxyProfile])}
        </>
      )
    else rerender(<>{card(authProfile, [authProfile, { ...authProfile }, proxyProfile])}</>)
    await act(async () => {
      auth.finish()
      await Promise.resolve()
    })
    expect(onUpdate).not.toHaveBeenCalled()
    expect(onReplaceProfiles).not.toHaveBeenCalled()
  })
})

const config = {
  download_dir: 'C:\\MagicPot\\Projects'
} as Config

describe('codexRendererExtension scoped assistant image AutoSave', () => {
  afterEach(() => {
    if (originalPathDescriptor) {
      Object.defineProperty(window, 'path', originalPathDescriptor)
    } else {
      Reflect.deleteProperty(window, 'path')
    }
  })

  it('isolates Agent AutoSave under the storage-scope project directory', () => {
    Object.defineProperty(window, 'path', {
      configurable: true,
      value: {
        join: (...segments: string[]) => segments.filter(Boolean).join('\\'),
        dirname: (value: string) => value.replace(/[\\/][^\\/]+[\\/]?$/g, '')
      }
    })

    expect(
      codexRendererExtension.chat?.resolveAssistantImageAutoSaveDir?.({
        config,
        storageScope: 'project-alpha.agent-thread'
      })
    ).toBe('C:\\MagicPot\\Projects\\.default-project__project-alpha\\AutoSave\\Agent')
  })

  it('leaves the default scope to the public global AutoSave fallback', () => {
    Object.defineProperty(window, 'path', {
      configurable: true,
      value: {
        join: (...segments: string[]) => segments.filter(Boolean).join('\\'),
        dirname: (value: string) => value.replace(/[\\/][^\\/]+[\\/]?$/g, '')
      }
    })

    expect(
      codexRendererExtension.chat?.resolveAssistantImageAutoSaveDir?.({
        config,
        storageScope: 'default'
      })
    ).toBeUndefined()
  })
})

describe('readonly thread image capability hint', () => {
  const hint = codexRendererExtension.chat!.hasThreadImageTool!
  it('recognizes a selected local Codex image backend without exposing credentials or doing work', () => {
    const config = {
      ...DEFAULT_CONFIG,
      use_remote_llm: false,
      llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [textProfile, proxyProfile] }
    }
    const linked = { ...textProfile, codex_image_profile_id: proxyProfile.id }
    config.llm_config.api_profiles = [linked, proxyProfile]
    expect(hint(config, linked.id)).toBe(true)
    expect(hint({ ...config, use_remote_llm: true }, linked.id)).toBe(false)
  })
  it.each(['missing', '', ' ', 'bad\nlink'])(
    'declines invalid explicit links (%s)',
    (selection) => {
      const source = { ...textProfile, codex_image_profile_id: selection }
      const config = {
        ...DEFAULT_CONFIG,
        use_remote_llm: false,
        llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [source, proxyProfile] }
      }
      expect(hint(config, source.id)).toBe(false)
    }
  )
  it('requires unique source and linked target and rejects unsupported source use', () => {
    const source = { ...textProfile, codex_image_profile_id: proxyProfile.id }
    const config = {
      ...DEFAULT_CONFIG,
      use_remote_llm: false,
      llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [source, proxyProfile] }
    }
    expect(
      hint(
        {
          ...config,
          llm_config: {
            ...config.llm_config,
            api_profiles: [source, proxyProfile, { ...proxyProfile, id: source.id }]
          }
        },
        source.id
      )
    ).toBe(false)
    expect(
      hint(
        {
          ...config,
          llm_config: {
            ...config.llm_config,
            api_profiles: [{ ...source, model_use: 'image' }, proxyProfile]
          }
        },
        source.id
      )
    ).toBe(false)
    expect(
      hint(
        {
          ...config,
          llm_config: {
            ...config.llm_config,
            api_profiles: [source, proxyProfile, { ...proxyProfile }]
          }
        },
        source.id
      )
    ).toBe(false)
  })
})
