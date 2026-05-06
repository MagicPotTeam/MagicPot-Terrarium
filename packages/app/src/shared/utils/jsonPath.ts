import { JsonDict, JsonValue, valueIsJsonDict } from '@shared/utils/utilTypes'

export type JsonPath = string

export function parseJsonPath(jsonPath: JsonPath): string[] {
  const pathFields = jsonPath.split('.')
  if (pathFields.length === 0) {
    throw new Error(`jsonPath is empty: ${jsonPath}`)
  }
  if (pathFields[0] === '$') {
    pathFields.shift()
  }
  return pathFields
}

export function getJsonPath(jsonPath: JsonPath, input: JsonValue): JsonValue {
  const pathFields = parseJsonPath(jsonPath)
  let value: JsonValue = input
  for (const field of pathFields) {
    if (!valueIsJsonDict(value)) {
      throw new Error(`field not found: ${jsonPath} in workflow: ${JSON.stringify(input)}`)
    }
    value = value[field]
  }
  return value
}

export function setJsonPath(jsonPath: JsonPath, dist: JsonDict, value: JsonValue) {
  const pathFields = parseJsonPath(jsonPath)
  const prevs = pathFields.slice(0, -1)
  const last = pathFields[pathFields.length - 1]

  let pointer: JsonDict = dist
  for (const field of prevs) {
    if (!valueIsJsonDict(pointer[field])) {
      throw new Error(`field is not an object: ${jsonPath} in workflow: ${JSON.stringify(dist)}`)
    }
    pointer = pointer[field]
  }
  pointer[last] = value
  return dist
}
