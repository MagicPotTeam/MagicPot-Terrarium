import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Fixed installation assets, never selected by an input file, renderer or environment.
export const DOCUMENT_WORKER_ASSETS = [
  'out/document-worker/index.cjs',
  'out/document-worker/THIRD-PARTY-NOTICES.txt',
  'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  'node_modules/pdfjs-dist/LICENSE'
] as const

/** Works for owned development roots and ASAR paths. Checks bytes, not ASAR virtual nlink.
 * This is corruption/closure detection, not code signing or an OS security sandbox. */
export function verifyDocumentWorkerAssets(appRoot: string): string {
  const manifest = JSON.parse(
    readFileSync(path.join(appRoot, 'out/document-worker/manifest.json'), 'utf8')
  )
  if (
    manifest?.protocol !== 'magicpot-document-worker-assets/v2' ||
    manifest.pdfjsVersion !== '6.3.289' ||
    manifest.saxesVersion !== '6.0.0' ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== DOCUMENT_WORKER_ASSETS.length
  )
    throw new Error('Document worker assets unavailable')
  for (const [index, relative] of DOCUMENT_WORKER_ASSETS.entries()) {
    const item = manifest.files[index]
    if (item?.path !== relative || !/^[a-f0-9]{64}$/.test(item.sha256))
      throw new Error('Document worker assets unavailable')
    const digest = createHash('sha256')
      .update(readFileSync(path.join(appRoot, relative)))
      .digest('hex')
    if (digest !== item.sha256) throw new Error('Document worker assets unavailable')
  }
  // electron-builder strips non-runtime package metadata. Verify its resolution
  // contract, not mutable raw JSON bytes; code and license hashes remain exact.
  const pdfPackage = JSON.parse(
    readFileSync(path.join(appRoot, 'node_modules/pdfjs-dist/package.json'), 'utf8')
  )
  if (
    pdfPackage?.name !== 'pdfjs-dist' ||
    pdfPackage.version !== '6.3.289' ||
    pdfPackage.main !== 'build/pdf.mjs' ||
    Object.hasOwn(pdfPackage, 'exports')
  )
    throw new Error('Document worker assets unavailable')
  return path.join(appRoot, DOCUMENT_WORKER_ASSETS[0])
}
