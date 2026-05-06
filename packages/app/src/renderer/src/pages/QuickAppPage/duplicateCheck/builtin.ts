import type { QAppMenuItem } from '@shared/api/svcQApp'

export const BUILTIN_DUPLICATE_CHECK_QAPP_KEY = '~builtin/inspection/duplicate-check'

export const isBuiltinDuplicateCheckQApp = (key: string): boolean =>
  key === BUILTIN_DUPLICATE_CHECK_QAPP_KEY

export const createBuiltinDuplicateCheckQApp = (): QAppMenuItem => ({
  key: BUILTIN_DUPLICATE_CHECK_QAPP_KEY,
  name: '\u91cd\u590d\u56fe\u68c0\u67e5',
  category: 'inspection',
  isBuiltin: true,
  isDirectory: false
})
