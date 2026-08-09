import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))

import { openReadOnlyDatabase, openReadWriteDatabase } from './sqliteAdapter'

const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const os = await vi.importActual<typeof import('node:os')>('node:os')

let directory: string

beforeEach(async () => {
  directory = await fs.mkdtemp(join(os.tmpdir(), 'magic-agent-sqlite-adapter-'))
})

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

describe('openReadOnlyDatabase', () => {
  it('opens an immutable file URL through Node SQLite while retaining the filesystem path', () => {
    const path = join(directory, 'path with spaces', 'events.sqlite')
    const writer = openReadWriteDatabase(path)
    writer.exec(
      'CREATE TABLE events (id INTEGER PRIMARY KEY) STRICT; INSERT INTO events VALUES (1)'
    )
    writer.close()

    const reader = openReadOnlyDatabase(path)
    try {
      expect(reader.path).toBe(path)
      expect(reader.database.location()).toBe(path)
      expect(reader.get('SELECT id FROM events')).toEqual({ id: 1 })
      expect(() => reader.exec('INSERT INTO events VALUES (2)')).toThrow(/readonly/i)
    } finally {
      reader.close()
    }
  })
})
