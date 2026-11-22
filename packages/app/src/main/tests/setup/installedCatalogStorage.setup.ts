import { afterAll, beforeAll, expect } from 'vitest'
import { provideConfinedCatalogStorage } from './installedCatalogStorage'

let release = (): void => {}

beforeAll(async () => {
  release = await provideConfinedCatalogStorage(expect.getState().testPath ?? '')
})

afterAll(() => {
  const done = release
  release = () => {}
  done()
})
