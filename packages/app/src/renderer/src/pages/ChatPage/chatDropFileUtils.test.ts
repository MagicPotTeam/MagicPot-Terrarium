import { describe, expect, it } from 'vitest'
import { hasDroppedDirectory, resolveDroppedDirectoryImageFiles } from './chatDropFileUtils'

describe('chatDropFileUtils', () => {
  it('detects directory drops from DataTransfer items', () => {
    const items = [
      {
        kind: 'file',
        webkitGetAsEntry: () => ({ isDirectory: true })
      },
      {
        kind: 'string'
      }
    ] as unknown as DataTransferItemList

    expect(hasDroppedDirectory(items)).toBe(true)
  })

  it('keeps only image files from dropped directories and preserves relative paths', () => {
    const descriptors = resolveDroppedDirectoryImageFiles([
      {
        path: 'after/hero.png',
        file: new File(['hero'], 'hero.png', { type: 'image/png' })
      },
      {
        path: 'after/readme.txt',
        file: new File(['notes'], 'readme.txt', { type: 'text/plain' })
      }
    ])

    expect(descriptors).toEqual([
      expect.objectContaining({
        relativePath: 'after/hero.png',
        file: expect.objectContaining({ name: 'hero.png' })
      })
    ])
  })
})
