import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('dev scripts invoke the Node launcher without a shell command chain', () => {
  assert.equal(packageJson.scripts['dev:pure'], 'node scripts/run-electron-vite.mjs dev --mode pure')
  assert.equal(
    packageJson.scripts['dev:embedded'],
    'cross-env TIPO_NO_AUTO_INSTALL=1 VITE_BUILD_MODE=embedded VITE_PACKAGE_MODE=embedded VITE_BUILD_MODE_NAME=Embedded VITE_MAGICPOT_AUTO_START_COMFYUI=true node scripts/run-electron-vite.mjs dev --mode embedded'
  )
  assert.doesNotMatch(packageJson.scripts['dev:pure'], /chcp|&&|cross-env-shell/)
  assert.doesNotMatch(packageJson.scripts['dev:embedded'], /chcp|&&|cross-env-shell/)
})
