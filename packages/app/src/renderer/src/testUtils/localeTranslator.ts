import { createInstance } from 'i18next'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'

export type LocaleTranslate = (key: string, options?: Record<string, unknown>) => string

const translators = new Map<string, LocaleTranslate>()

/**
 * Real i18next translation backed by the renderer locale files, for tests that mock
 * react-i18next. Any language starting with "zh" reads zh-CN; everything else en-US.
 */
export function localeTranslator(language: string): LocaleTranslate {
  const lng = language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
  const cached = translators.get(lng)
  if (cached) return cached
  const instance = createInstance()
  void instance.init({
    lng,
    fallbackLng: 'en-US',
    resources: { 'en-US': { translation: en }, 'zh-CN': { translation: zh } },
    interpolation: { escapeValue: false },
    initAsync: false
  })
  const t = instance.t as unknown as LocaleTranslate
  const translate: LocaleTranslate = (key, options) => t(key, options)
  translators.set(lng, translate)
  return translate
}

/**
 * Translates only the keys under `prefixes` with the locale files and hands every other key
 * to `fallback`, so a test that asserts on raw keys elsewhere keeps doing so.
 */
export function scopedLocaleTranslator(
  language: string,
  prefixes: readonly string[],
  fallback: LocaleTranslate
): LocaleTranslate {
  const translate = localeTranslator(language)
  return (key, options) =>
    prefixes.some((prefix) => key.startsWith(prefix))
      ? translate(key, options)
      : fallback(key, options)
}

/**
 * Mirrors a mock t that shows each call's own defaultValue (interpolated), but reads the locale
 * file for calls that pass none, so text that lives only in the locale files still renders.
 */
export function defaultValueFirstTranslator(language: string): LocaleTranslate {
  const translate = localeTranslator(language)
  return (key, options) =>
    typeof options?.defaultValue === 'string'
      ? translate('__test_missing_key__', options)
      : translate(key, options)
}

// Keys whose text lives only in the locale files: the calls pass no defaultValue, so a mock
// that echoes the key would show the key where the page shows text.
const LOCALE_ONLY_PREFIXES = [
  'chat.team_notice.',
  'chat.queue_item.',
  'chat.team_member_status.'
] as const
const LOCALE_ONLY_KEYS = new Set([
  'agent_workspace.member_form.create_aria',
  'agent_workspace.member_form.create_label',
  'agent_workspace.member_form.create_unconfirmed',
  'agent_workspace.member_form.limit_invalid',
  'agent_workspace.member_form.limit_reached',
  'agent_workspace.member_form.name',
  'agent_workspace.member_form.role',
  'chat.context_budget_preview_ratio',
  'chat.context_compression_preview_idle',
  'chat.context_compression_preview_planned',
  'chat.context_compression_preview_trigger',
  'chat.context_window_preview_ratio',
  'chat.context_window_preview_tokens',
  'chat.draft_attachment_save_failed',
  'chat.edit_message_changed',
  'chat.folder_drop_too_many',
  'chat.image_count_over_limit',
  'chat.loading_image_generation',
  'chat.member_model_inherit',
  'chat.new_conversation_keep_original',
  'chat.queue_edit_busy',
  'chat.skill_none',
  'chat.team_lead_row',
  'chat.team_live_unknown_tool',
  'chat.team_member_default_name'
])

/**
 * zh-CN text for a key whose text lives only in the locale files, else the key itself: a
 * drop-in for the key fallback of a mock that echoes keys.
 */
export function zhLocaleText(key: string, options?: Record<string, unknown>): string {
  const localeOnly =
    LOCALE_ONLY_KEYS.has(key) || LOCALE_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix))
  return localeOnly ? localeTranslator('zh-CN')(key, options) : key
}

/**
 * A react-i18next module for vi.mock. Each call's defaultValue wins, as with an unconfigured
 * react-i18next; calls without one read the locale files.
 */
export function reactI18nextMock(language: string) {
  const t = defaultValueFirstTranslator(language)
  const i18n = { language, resolvedLanguage: language }
  return {
    useTranslation: () => ({ t, i18n }),
    initReactI18next: { type: '3rdParty' as const, init: () => undefined }
  }
}
