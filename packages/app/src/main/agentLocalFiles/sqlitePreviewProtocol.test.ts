import { describe, expect, it } from 'vitest'
import { decodeSqlitePreviewSnapshot } from './sqlitePreviewProtocol'

const snapshot = Buffer.alloc(100)
snapshot.write('SQLite format 3\0', 'binary')
const request = { version: 1, requestId: 'owned-fixture', snapshotBase64: snapshot.toString('base64'), table: 'fixture', columns: ['id'], limit: 10 }
describe('dedicated SQLite child request', () => {
  it('decodes bounded supplied bytes without accepting path, SQL or authority', () => {
    expect(decodeSqlitePreviewSnapshot(request).snapshot).toEqual(snapshot)
    const large = Buffer.alloc(8 * 1024 * 1024)
    snapshot.copy(large)
    expect(decodeSqlitePreviewSnapshot({ ...request, snapshotBase64: large.toString('base64') }).snapshot.length).toBe(large.length)
    for (const input of [{ ...request, path: '/private.db' }, { ...request, sql: 'SELECT 1' },
      { ...request, grant: 'never' }, { ...request, columns: ['id', 'id'] }, { ...request, table: 'x;DROP' },
      { ...request, limit: 101 }, { ...request, snapshotBase64: 'not-base64' },
      { ...request, snapshotBase64: Buffer.alloc(100).toString('base64') },
      { ...request, snapshotBase64: request.snapshotBase64 + '\n' }]) expect(() => decodeSqlitePreviewSnapshot(input)).toThrow()
  })
})
