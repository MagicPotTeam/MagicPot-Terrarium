import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const safe = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  getSelectedStorageBackend: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  getPath: vi.fn()
}))
vi.mock('electron', () => ({ safeStorage: safe, app: { getPath: safe.getPath } }))
import { checkpointCodec, windowsCheckpointKeyReady } from './checkpointEncryption'
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', platformDescriptor)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
describe('OS checkpoint codec boundary', () => {
  it('refuses an unavailable OS key store and never enables a plaintext fallback', () => {
    safe.isEncryptionAvailable.mockReturnValue(false)
    expect(checkpointCodec.available()).toBe(false)
    expect(safe.encryptString).not.toHaveBeenCalled()
  })
  it('rejects Linux basic_text and unknown key stores, accepts an actual selected key store', () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' })
    safe.isEncryptionAvailable.mockReturnValue(true)
    for (const backend of ['basic_text', 'unknown']) {
      safe.getSelectedStorageBackend.mockReturnValue(backend)
      expect(checkpointCodec.available()).toBe(false)
    }
    safe.getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
    expect(checkpointCodec.available()).toBe(true)
  })
  it('passes only explicit text and ciphertext to the platform encryptor', () => {
    const cipher = Buffer.from([1, 2, 3])
    safe.encryptString.mockReturnValue(cipher)
    safe.decryptString.mockReturnValue('OWNED')
    expect(checkpointCodec.encrypt('OWNED')).toBe(cipher)
    expect(checkpointCodec.decrypt(cipher)).toBe('OWNED')
    expect(safe.encryptString).toHaveBeenCalledWith('OWNED')
    expect(safe.decryptString).toHaveBeenCalledWith(cipher)
  })
  it('does not equate usable encryption with a persisted fresh Windows profile key', () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mp-os-key-'))
    roots.push(root)
    safe.getPath.mockImplementation((name: string) =>
      name === 'sessionData' ? root : path.join(root, 'wrong-profile')
    )
    safe.isEncryptionAvailable.mockReturnValue(true)
    safe.encryptString.mockReturnValue(Buffer.from('OWNED'))
    expect(checkpointCodec.available()).toBe(false)
    expect(fs.readdirSync(root)).toEqual([])
    const file = path.join(root, 'Local State')
    for (const text of ['{', '{}', JSON.stringify({ os_crypt: { encrypted_key: '' } })]) {
      fs.writeFileSync(file, text)
      expect(windowsCheckpointKeyReady()).toBe(false)
    }
    fs.writeFileSync(
      file,
      JSON.stringify({ os_crypt: { encrypted_key: 'OWNED_TEST_MARKER_NOT_A_REAL_KEY' } })
    )
    const before = fs.readFileSync(file)
    expect(checkpointCodec.available()).toBe(true)
    expect(fs.readFileSync(file).equals(before)).toBe(true)
    fs.linkSync(file, path.join(root, 'owned-link'))
    expect(windowsCheckpointKeyReady()).toBe(false)
  })
})
