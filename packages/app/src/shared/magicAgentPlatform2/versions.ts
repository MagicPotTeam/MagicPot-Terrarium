export type ContractVersion = Readonly<{
  major: number
  minor: number
  patch: number
  value: string
}>

const version = (major: number, minor = 0, patch = 0): ContractVersion =>
  Object.freeze({ major, minor, patch, value: `${major}.${minor}.${patch}` })

export const GRAPH_SCHEMA_VERSION = version(2)
export const SESSION_STORAGE_VERSION = version(1)
export const PACKAGE_MANIFEST_VERSION = version(1)
export const RUNTIME_PROTOCOL_VERSION = version(2)
export const SDK_VERSION = version(2)

export const MAGIC_AGENT_PLATFORM_2_VERSION_MATRIX = Object.freeze({
  graphSchema: GRAPH_SCHEMA_VERSION,
  sessionStorage: SESSION_STORAGE_VERSION,
  packageManifest: PACKAGE_MANIFEST_VERSION,
  runtimeProtocol: RUNTIME_PROTOCOL_VERSION,
  sdk: SDK_VERSION
})

export const SUPPORTED_RUNTIME_PROTOCOL_MAJOR_VERSIONS: readonly number[] = Object.freeze([
  RUNTIME_PROTOCOL_VERSION.major
])
