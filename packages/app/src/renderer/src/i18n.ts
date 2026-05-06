import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shared/locales/zh-CN/renderer.json'
import en from '@shared/locales/en-US/renderer.json'
import I18nextBrowserLanguageDetector from 'i18next-browser-languagedetector'

export const resources = {
  'en-US': { translation: en },
  'zh-CN': { translation: zh }
}

i18n
  .use(initReactI18next)
  .use(I18nextBrowserLanguageDetector)
  .init({
    resources,
    fallbackLng: 'en-US',
    supportedLngs: ['en-US', 'zh-CN'],
    detection: {
      convertDetectedLanguage: (lng) => (lng.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US')
    },
    interpolation: {
      escapeValue: false
    }
  })

export default i18n
