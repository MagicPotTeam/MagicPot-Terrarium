/**
 * JSON 基本类型
 */
export type Primitive = string | boolean | number | Date | Uint8Array | bigint | null

/**
 * JSON 列表类型
 */
export type JsonList = JsonValue[]

/**
 * JSON 字典类型
 */
export type JsonDict = { [key: string]: JsonValue }

/**
 * JSON 类型
 */
export type JsonValue = Primitive | JsonList | JsonDict

export function isPrimitive(value: unknown): value is Primitive {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    value instanceof Date ||
    value instanceof Uint8Array ||
    typeof value === 'bigint' ||
    value === null
  )
}

export function isJsonList(value: unknown): value is JsonList {
  return Array.isArray(value) && value.every(isJsonValue)
}

export function isJsonDict(value: unknown): value is JsonDict {
  return (
    typeof value === 'object' &&
    !(
      value === null ||
      Array.isArray(value) ||
      value instanceof Date ||
      value instanceof Uint8Array ||
      typeof value === 'bigint'
    ) &&
    Object.values(value).every(isJsonValue)
  )
}

export function isJsonValue(value: unknown): value is JsonValue {
  return isPrimitive(value) || isJsonList(value) || isJsonDict(value)
}

/**
 * 快速判断一个 JsonValue 是否为 JsonList
 * 不进行类型检查，直接判断是否为数组
 * 原版 isJsonList 已造成性能瓶颈，
 * 如果已确认 value 为 JsonValue，则使用 valueIsJsonList 进行快速判断
 */
export function valueIsJsonList(value: JsonValue): value is JsonList {
  return Array.isArray(value)
}

/**
 * 快速判断一个 JsonValue 是否为 JsonDict
 * 不进行类型检查，直接判断是否为对象
 * 原版 isJsonDict 已造成性能瓶颈，
 * 如果已确认 value 为 JsonValue，则使用 valueIsJsonDict 进行快速判断
 */
export function valueIsJsonDict(value: JsonValue): value is JsonDict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * DeepPartial 深度部分类型
 */
export type DeepPartial<T> = T extends Primitive
  ? T
  : T extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T extends ReadonlyArray<infer U>
      ? ReadonlyArray<DeepPartial<U>>
      : T extends object
        ? { [K in keyof T]?: DeepPartial<T[K]> }
        : Partial<T>

export function deepCopy<T extends JsonValue>(v: T): T {
  if (v === null || v === undefined) {
    return v
  }
  if (
    typeof v === 'string' ||
    typeof v === 'boolean' ||
    typeof v === 'number' ||
    typeof v === 'bigint'
  ) {
    return v
  }
  if (v instanceof Date) {
    return new Date(v.getTime()) as T
  }
  if (v instanceof Uint8Array) {
    return new Uint8Array(v) as T
  }

  if (valueIsJsonList(v)) {
    return v.map(deepCopy) as T
  }

  if (valueIsJsonDict(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, v]) => [k, deepCopy(v)])) as T
  }

  throw new Error('Invalid JSON value: ' + JSON.stringify(v))
}

export function deepMerge<T extends JsonValue | undefined>(a: T, b: T): T {
  if (a === null || a === undefined) {
    return b
  }
  if (b === null || b === undefined) {
    return a // undefined 穿透
  }
  if (isPrimitive(a) || isPrimitive(b)) {
    return b // 基础类型直接替换
  }
  if (valueIsJsonList(a) && valueIsJsonList(b)) {
    return b // list 不再合并，直接替换
  }
  if (valueIsJsonDict(a) && valueIsJsonDict(b)) {
    // 字典合并，递归合并
    const result = Object.assign({}, a) // 先复制 a 的所有属性
    // 然后合并 b 的属性
    Object.entries(b).forEach(([k, v]) => {
      result[k] = deepMerge(a[k], v)
    })
    return result as T
  }

  // 两者类型不同，直接替换
  return b
}

export type Unionize<T> = T[keyof T]
