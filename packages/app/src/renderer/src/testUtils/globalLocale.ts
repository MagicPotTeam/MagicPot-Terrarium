import i18next from 'i18next'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'

// Import for its side effect: the shared i18next instance reads the zh-CN locale file, as the
// app does once its renderer starts, so modules that call i18next.t outside React show real text.
if (!i18next.isInitialized) {
  void i18next.init({
    lng: 'zh-CN',
    fallbackLng: 'en-US',
    resources: { 'en-US': { translation: en }, 'zh-CN': { translation: zh } },
    interpolation: { escapeValue: false },
    initAsync: false
  })
}
