import { describe, expect, it } from 'vitest'
import { isPrivateOrLocalProviderHost, validateProviderBaseUrl } from './providerEndpointPolicy'

describe('provider endpoint policy', () => {
  it.each([
    'localhost',
    '127.0.0.1',
    '192.168.1.30',
    '10.0.0.4',
    '172.16.4.8',
    '::1',
    '[fd00::1]',
    'gateway.local'
  ])('classifies %s as local/private', (hostname) => {
    expect(isPrivateOrLocalProviderHost(hostname)).toBe(true)
  })

  it.each(['api.example.com', '8.8.8.8', '999.999.999.999', '224.0.0.1', '2001:4860:4860::8888'])(
    'does not classify %s as local/private',
    (hostname) => {
      expect(isPrivateOrLocalProviderHost(hostname)).toBe(false)
    }
  )

  it.each([
    'https://api.example.com/v1',
    'http://127.0.0.1:8080/v1',
    'http://192.168.1.12:9000/gateway',
    'https://[2001:db8::1]/v1'
  ])('accepts safe provider endpoint %s', (endpoint) => {
    expect(validateProviderBaseUrl(endpoint)).toBe(endpoint)
  })

  it.each([
    'http://api.example.com/v1',
    'http://224.0.0.1:8080/v1',
    'ftp://api.example.com/v1',
    'https://user:password@api.example.com/v1',
    'https://api.example.com/v1?api_key=secret',
    'https://api.example.com/v1#fragment',
    'https://api.example.com/v1\n'
  ])('rejects unsafe provider endpoint %s', (endpoint) => {
    expect(() => validateProviderBaseUrl(endpoint)).toThrow()
  })
})
