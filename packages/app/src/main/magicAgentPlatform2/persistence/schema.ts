export const MAX_SQLITE_SAFE_INTEGER = 9007199254740991

export const SCHEMA_METADATA_DDL = `CREATE TABLE schema_metadata (
  key TEXT PRIMARY KEY NOT NULL CHECK(length(trim(key)) > 0),
  value TEXT NOT NULL CHECK(length(trim(value)) > 0),
  updated_at REAL NOT NULL CHECK(updated_at = updated_at AND abs(updated_at) <= 1.7976931348623157e308)
) STRICT`
export const EVENTS_DDL = `CREATE TABLE events (
  event_id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(event_id)) > 0),
  protocol_version TEXT NOT NULL CHECK(length(trim(protocol_version)) > 0),
  stream_id TEXT NOT NULL CHECK(length(trim(stream_id)) > 0),
  sequence INTEGER NOT NULL CHECK(sequence >= 0 AND sequence <= ${MAX_SQLITE_SAFE_INTEGER}),
  type TEXT NOT NULL CHECK(length(trim(type)) > 0),
  created_at REAL NOT NULL CHECK(created_at = created_at AND abs(created_at) <= 1.7976931348623157e308),
  correlation_id TEXT CHECK(correlation_id IS NULL OR length(trim(correlation_id)) > 0),
  causation_id TEXT CHECK(causation_id IS NULL OR length(trim(causation_id)) > 0),
  idempotency_key TEXT CHECK(idempotency_key IS NULL OR length(trim(idempotency_key)) > 0),
  payload_json TEXT NOT NULL CHECK(length(trim(payload_json)) > 0),
  envelope_json TEXT NOT NULL CHECK(length(trim(envelope_json)) > 0),
  inserted_at REAL NOT NULL CHECK(inserted_at = inserted_at AND abs(inserted_at) <= 1.7976931348623157e308),
  UNIQUE(stream_id, sequence)
) STRICT`
export const IDEMPOTENCY_INDEX_DDL =
  'CREATE UNIQUE INDEX events_idempotency_key_unique ON events(idempotency_key) WHERE idempotency_key IS NOT NULL'
export const STREAM_INDEX_DDL =
  'CREATE INDEX events_stream_sequence_idx ON events(stream_id, sequence)'
export const CREATED_AT_INDEX_DDL = 'CREATE INDEX events_created_at_idx ON events(created_at)'
export const SNAPSHOTS_DDL = `CREATE TABLE snapshots (
  snapshot_id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(snapshot_id)) > 0),
  stream_id TEXT NOT NULL CHECK(length(trim(stream_id)) > 0),
  snapshot_version INTEGER NOT NULL CHECK(snapshot_version >= 0 AND snapshot_version <= ${MAX_SQLITE_SAFE_INTEGER}),
  covered_sequence INTEGER NOT NULL CHECK(covered_sequence >= -1 AND covered_sequence <= ${MAX_SQLITE_SAFE_INTEGER}),
  state_type TEXT NOT NULL CHECK(length(trim(state_type)) > 0),
  state_json TEXT NOT NULL CHECK(length(trim(state_json)) > 0),
  metadata_json TEXT CHECK(metadata_json IS NULL OR length(trim(metadata_json)) > 0),
  created_at REAL NOT NULL CHECK(created_at = created_at AND abs(created_at) <= 1.7976931348623157e308),
  inserted_at REAL NOT NULL CHECK(inserted_at = inserted_at AND abs(inserted_at) <= 1.7976931348623157e308),
  UNIQUE(stream_id, snapshot_version)
) STRICT`
export const SNAPSHOT_VERSION_INDEX_DDL =
  'CREATE INDEX snapshots_stream_version_idx ON snapshots(stream_id, snapshot_version DESC)'
export const SNAPSHOT_COVERED_INDEX_DDL =
  'CREATE INDEX snapshots_stream_covered_idx ON snapshots(stream_id, covered_sequence)'
export const RESOURCES_DDL = `CREATE TABLE resources (
  resource_kind TEXT NOT NULL CHECK(length(trim(resource_kind)) > 0),
  resource_id TEXT NOT NULL CHECK(length(trim(resource_id)) > 0),
  revision INTEGER NOT NULL CHECK(revision >= 0 AND revision <= ${MAX_SQLITE_SAFE_INTEGER}),
  state_json TEXT NOT NULL CHECK(length(trim(state_json)) > 0),
  deleted INTEGER NOT NULL CHECK(deleted IN (0, 1)),
  created_at REAL NOT NULL CHECK(created_at = created_at AND abs(created_at) <= 1.7976931348623157e308),
  updated_at REAL NOT NULL CHECK(updated_at = updated_at AND abs(updated_at) <= 1.7976931348623157e308 AND updated_at >= created_at),
  PRIMARY KEY(resource_kind, resource_id)
) STRICT`
export const RESOURCES_KIND_DELETED_UPDATED_INDEX_DDL =
  'CREATE INDEX resources_kind_deleted_updated_idx ON resources(resource_kind, deleted, updated_at)'
export const RESOURCES_UPDATED_INDEX_DDL =
  'CREATE INDEX resources_updated_at_idx ON resources(updated_at)'
export const RESOURCE_MUTATIONS_DDL = `CREATE TABLE resource_mutations (
  idempotency_key TEXT PRIMARY KEY NOT NULL CHECK(length(trim(idempotency_key)) > 0),
  resource_kind TEXT NOT NULL CHECK(length(trim(resource_kind)) > 0),
  resource_id TEXT NOT NULL CHECK(length(trim(resource_id)) > 0),
  operation TEXT NOT NULL CHECK(operation IN ('create', 'update', 'delete')),
  expected_revision INTEGER CHECK(expected_revision IS NULL OR (expected_revision >= 0 AND expected_revision <= ${MAX_SQLITE_SAFE_INTEGER})),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision >= 0 AND resulting_revision <= ${MAX_SQLITE_SAFE_INTEGER}),
  event_id TEXT NOT NULL,
  command_json TEXT NOT NULL CHECK(length(trim(command_json)) > 0),
  result_json TEXT NOT NULL CHECK(length(trim(result_json)) > 0),
  created_at REAL NOT NULL CHECK(created_at = created_at AND abs(created_at) <= 1.7976931348623157e308),
  FOREIGN KEY(resource_kind, resource_id) REFERENCES resources(resource_kind, resource_id),
  FOREIGN KEY(event_id) REFERENCES events(event_id)
) STRICT`
export const RESOURCE_MUTATIONS_RESOURCE_REVISION_INDEX_DDL =
  'CREATE INDEX resource_mutations_resource_revision_idx ON resource_mutations(resource_kind, resource_id, resulting_revision)'
export const RESOURCE_MUTATIONS_CREATED_INDEX_DDL =
  'CREATE INDEX resource_mutations_created_at_idx ON resource_mutations(created_at)'

export const EVENT_STORE_V1_SCHEMA_SQL = `${SCHEMA_METADATA_DDL};
${EVENTS_DDL};
${IDEMPOTENCY_INDEX_DDL};
${STREAM_INDEX_DDL};
${CREATED_AT_INDEX_DDL};`

export const EVENT_STORE_V2_ADDITIONS_SQL = `${SNAPSHOTS_DDL};
${SNAPSHOT_VERSION_INDEX_DDL};
${SNAPSHOT_COVERED_INDEX_DDL};`

export const EVENT_STORE_V2_SCHEMA_SQL = `${EVENT_STORE_V1_SCHEMA_SQL}
${EVENT_STORE_V2_ADDITIONS_SQL}`

export const EVENT_STORE_V3_ADDITIONS_SQL = `${RESOURCES_DDL};
${RESOURCES_KIND_DELETED_UPDATED_INDEX_DDL};
${RESOURCES_UPDATED_INDEX_DDL};
${RESOURCE_MUTATIONS_DDL};
${RESOURCE_MUTATIONS_RESOURCE_REVISION_INDEX_DDL};
${RESOURCE_MUTATIONS_CREATED_INDEX_DDL};`

export const EVENT_STORE_V3_SCHEMA_SQL = `${EVENT_STORE_V2_SCHEMA_SQL}
${EVENT_STORE_V3_ADDITIONS_SQL}`
