import { useTranslation } from 'react-i18next'

/**
 * 用于翻译 QApp 配置中的 label
 * 翻译规则：t('qapp.labels.${label}') 命中则返回翻译；否则回退原值
 * @param label 原始 label
 * @returns 翻译后的 label
 */
export const useQAppLabel = (label: string): string => {
  const { t } = useTranslation()

  if (!label) return ''

  const translationKey = `qapp.labels.${label}`
  const translated = t(translationKey) as string

  // 如果翻译键不存在，t() 会返回键本身，所以我们检查是否相同
  return translated !== translationKey ? translated : label
}
