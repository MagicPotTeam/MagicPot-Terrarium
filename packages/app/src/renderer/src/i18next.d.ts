import 'i18next'
import { resources } from './i18n'

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: typeof resources.zh
  }
}
