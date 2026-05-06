const DEFAULT_GROUP_NAME_ZH_PREFIX = '\u7EC4\u5408'
const REPAIRED_DEFAULT_GROUP_NAME_PREFIXES = [
  '\u7F01\u52EB\u608E',
  '\u7F02\u509A\u5038\u934A\u6401\u5D10\u93BC\u4F78\u78F9'
]

function toChineseNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  return String(Math.floor(value))
}

export function buildNormalizedDefaultGroupName(index: number, language?: string | null): string {
  return language?.startsWith('zh')
    ? `${DEFAULT_GROUP_NAME_ZH_PREFIX}${toChineseNumber(index)}`
    : `Group ${index}`
}

export function shouldRepairNormalizedDefaultGroupName(name: string): boolean {
  return REPAIRED_DEFAULT_GROUP_NAME_PREFIXES.some((prefix) => name.includes(prefix))
}
