import { JsonDict, JsonValue, valueIsJsonDict } from '@shared/utils/utilTypes'

export type JsonPath = string

// Designers also tokenize incomplete slots to display validation hints.
export function parseJsonPath(jsonPath: JsonPath): string[] {
  const pathFields = jsonPath.split('.')
  if (pathFields[0] === '$') {
    pathFields.shift()
  }
  return pathFields
}

function parseJsonPathForAccess(jsonPath: JsonPath): string[] {
  const pathFields = parseJsonPath(jsonPath)
  if (pathFields.some((field) => field === '')) {
    throw new Error(`jsonPath contains an empty field: ${jsonPath}`)
  }
  return pathFields
}

export function getJsonPath(jsonPath: JsonPath, input: JsonValue): JsonValue {
  const pathFields = parseJsonPathForAccess(jsonPath)
  let value: JsonValue = input
  for (const field of pathFields) {
    if (!valueIsJsonDict(value)) {
      throw new Error(`field not found: ${jsonPath}`)
    }
    // A JSON field is own data, never a prototype member or an accessor.
    value = Object.getOwnPropertyDescriptor(value, field)?.value
  }
  return value
}

export function setJsonPath(jsonPath: JsonPath, dist: JsonDict, value: JsonValue) {
  const pathFields = parseJsonPathForAccess(jsonPath)
  if (pathFields.length === 0) {
    throw new Error(`jsonPath must name a field: ${jsonPath}`)
  }
  const prevs = pathFields.slice(0, -1)
  const last = pathFields[pathFields.length - 1]

  let pointer: JsonDict = dist
  for (const field of prevs) {
    const next = Object.getOwnPropertyDescriptor(pointer, field)?.value
    if (!valueIsJsonDict(next)) {
      throw new Error(`field is not an object: ${jsonPath}`)
    }
    pointer = next
  }
  // Define data explicitly so a field named __proto__ cannot invoke its inherited setter.
  Object.defineProperty(pointer, last, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  })
  return dist
}
