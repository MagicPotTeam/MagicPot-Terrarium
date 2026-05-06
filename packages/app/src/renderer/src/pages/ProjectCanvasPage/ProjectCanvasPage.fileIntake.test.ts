import { describe, expect, it } from 'vitest'

import { ALL_ACCEPT, detectFileType, isModelArchiveFile } from './types'
import { CANVAS_IMPORT_ACCEPT } from './canvasImportAccept'
import { resolveOfficeFileNodeData } from './officePreviewUtils'
import { PSD_IMPORT_ACCEPT, isPsdImportFile } from './psdImport'

const buildIntakeFile = (name: string, type = 'application/octet-stream'): File =>
  new File(['payload'], name, { type })

const encodeUtf16Le = (text: string): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(text.length * 2)
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index)
    bytes[index * 2] = codeUnit & 0xff
    bytes[index * 2 + 1] = codeUnit >> 8
  }
  return bytes
}

const isCanvasIntakeCandidate = (file: Pick<File, 'name' | 'type'>): boolean => {
  const fileType = detectFileType(file.name)

  return (
    isPsdImportFile(file) ||
    fileType === 'image' ||
    fileType === 'model3d' ||
    fileType === 'video' ||
    fileType === 'file' ||
    isModelArchiveFile(file.name) ||
    file.type.startsWith('image/') ||
    file.type.startsWith('video/')
  )
}

describe('ProjectCanvasPage file intake', () => {
  it('keeps the canvas import accept list aligned with office and legacy media files', () => {
    expect(ALL_ACCEPT).toContain('image/*')
    expect(ALL_ACCEPT).toContain('video/*')
    expect(ALL_ACCEPT).toContain('.psd')
    expect(ALL_ACCEPT).toContain('.psb')
    expect(ALL_ACCEPT).not.toContain('.pur')
    expect(CANVAS_IMPORT_ACCEPT).toContain('.psd')
    expect(CANVAS_IMPORT_ACCEPT).toContain('.psb')
    expect(CANVAS_IMPORT_ACCEPT).not.toContain('.pur')
    expect(PSD_IMPORT_ACCEPT).toContain('.psd')
    expect(PSD_IMPORT_ACCEPT).toContain('.psb')

    for (const ext of ['.txt', '.md', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']) {
      expect(ALL_ACCEPT).toContain(ext)
      expect(detectFileType(`example${ext}`)).toBe('file')
    }

    for (const ext of ['.glb', '.gltf', '.obj', '.fbx', '.stl', '.zip']) {
      expect(ALL_ACCEPT).toContain(ext)
    }
  })

  it.each([
    ['notes.txt', 'text/plain'],
    ['readme.md', 'text/markdown'],
    ['table.csv', 'text/csv'],
    ['brief.doc', 'application/msword'],
    ['brief.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['sheet.xls', 'application/vnd.ms-excel'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['slides.ppt', 'application/vnd.ms-powerpoint'],
    ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
  ])('accepts %s as a file-node intake candidate', (name, type) => {
    const file = buildIntakeFile(name, type)

    expect(detectFileType(file.name)).toBe('file')
    expect(isCanvasIntakeCandidate(file)).toBe(true)
  })

  it.each([
    ['photo.png', 'image/png', 'image', false],
    ['clip.mp4', 'video/mp4', 'video', false],
    ['scene.glb', 'model/gltf-binary', 'model3d', false],
    ['archive.zip', 'application/zip', null, true]
  ])('keeps %s on its legacy intake path', (name, type, expectedType, isArchive) => {
    const file = buildIntakeFile(name, type)

    expect(isCanvasIntakeCandidate(file)).toBe(true)
    expect(isModelArchiveFile(file.name)).toBe(isArchive)
    expect(detectFileType(file.name)).toBe(expectedType)
  })

  it('rejects unsupported .pur files from the canvas intake gate', () => {
    const file = buildIntakeFile('1(1).pur')

    expect(detectFileType(file.name)).toBeNull()
    expect(isCanvasIntakeCandidate(file)).toBe(false)
  })

  it('rejects unrelated files from the canvas intake gate', () => {
    const file = buildIntakeFile('notes.pdf', 'application/pdf')

    expect(detectFileType(file.name)).toBeNull()
    expect(isCanvasIntakeCandidate(file)).toBe(false)
  })

  it.each([
    ['poster.psd', 'image/vnd.adobe.photoshop'],
    ['archive.psb', 'application/octet-stream']
  ])('accepts %s as a direct PSD/PSB intake candidate', (name, type) => {
    const file = buildIntakeFile(name, type)

    expect(isPsdImportFile(file)).toBe(true)
    expect(isCanvasIntakeCandidate(file)).toBe(true)
  })

  it('resolves legacy office files into canonical file-node metadata', async () => {
    await expect(
      resolveOfficeFileNodeData(buildIntakeFile('table.csv', 'text/csv'))
    ).resolves.toEqual({
      mimeType: 'text/csv',
      fileKind: 'excel',
      editable: true,
      previewText: 'payload',
      previewImages: [],
      previewSheets: [],
      content: 'payload'
    })

    await expect(
      resolveOfficeFileNodeData(buildIntakeFile('brief.doc', 'application/msword'))
    ).resolves.toEqual({
      mimeType: 'application/msword',
      fileKind: 'word',
      editable: false,
      previewText: null,
      previewImages: [],
      previewSheets: [],
      content: null
    })

    await expect(
      resolveOfficeFileNodeData(buildIntakeFile('sheet.xls', 'application/vnd.ms-excel'))
    ).resolves.toEqual({
      mimeType: 'application/vnd.ms-excel',
      fileKind: 'excel',
      editable: false,
      previewText: null,
      previewImages: [],
      previewSheets: [],
      content: null
    })

    await expect(
      resolveOfficeFileNodeData(buildIntakeFile('slides.ppt', 'application/vnd.ms-powerpoint'))
    ).resolves.toEqual({
      mimeType: 'application/vnd.ms-powerpoint',
      fileKind: 'powerpoint',
      editable: false,
      previewText: null,
      previewImages: [],
      previewSheets: [],
      content: null
    })
  })

  it('keeps extracted legacy doc preview text on the file-node intake path', async () => {
    const file = new File(
      [
        new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        encodeUtf16Le('Requirement brief'),
        new Uint8Array([7, 8])
      ],
      'brief.doc',
      {
        type: 'application/msword'
      }
    )

    await expect(resolveOfficeFileNodeData(file)).resolves.toEqual({
      mimeType: 'application/msword',
      fileKind: 'word',
      editable: false,
      previewText: 'Requirement brief',
      previewImages: [],
      previewSheets: [],
      content: null
    })
  })
})
