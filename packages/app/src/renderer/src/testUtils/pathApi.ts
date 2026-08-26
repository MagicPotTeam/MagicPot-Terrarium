import type { BuiltInPath } from '@shared/utils/utilWindow'

export const pathApi = {
  join: (first: string, ...args: string[]) => [first, ...args].filter(Boolean).join('\\'),
  isAbsolute: (value: string) => /^[A-Z]:\\/i.test(value) || value.startsWith('/'),
  normalize: (value: string) => value,
  relative: (from: string, to: string) => to.replace(`${from}\\`, ''),
  dirname: (value: string) => value.split('\\').slice(0, -1).join('\\'),
  basename: (value: string) => value.split('\\').pop() || '',
  extname: (value: string) => {
    const base = value.split('\\').pop() || ''
    const index = base.lastIndexOf('.')
    return index >= 0 ? base.slice(index) : ''
  },
  format: () => '',
  parse: () => ({})
} satisfies BuiltInPath
