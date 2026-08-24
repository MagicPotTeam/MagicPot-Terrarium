import path from 'node:path'

export const app = {
  getPath(name: string): string {
    if (name !== 'userData') throw new Error(`Unsupported Electron path in SQLite worker: ${name}`)
    const userDataRoot = process.argv[2]
    if (!userDataRoot) throw new Error('SQLite durability worker requires a user-data root.')
    return path.resolve(userDataRoot)
  }
}
