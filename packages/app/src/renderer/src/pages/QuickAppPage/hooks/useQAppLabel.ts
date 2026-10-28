import { useTranslation } from 'react-i18next'

const getQAppLabelTranslationKey = (label: string): string => `qapp.labels.${label}`

/**
 * 用于翻译 QApp 配置中的 label
 * 翻译规则：t('qapp.labels.${label}') 命中则返回翻译；否则回退原值
 * @param label 原始 label
 * @returns 翻译后的 label
 */
export const useQAppLabel = (label: string): string => {
  const { t } = useTranslation()
  if (!label) return ''

  const translated = t(getQAppLabelTranslationKey(label), { defaultValue: label })

  return translated
}
