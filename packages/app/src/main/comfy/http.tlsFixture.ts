import { generate } from 'selfsigned'

const TLS_TEST_HOSTS = ['pinned-tls.example.test', 'pinned-wss.example.test'] as const

export const createTlsTestCredentials = async (): Promise<{ key: string; cert: string }> => {
  const notBeforeDate = new Date(Date.now() - 60_000)
  const notAfterDate = new Date(Date.now() + 24 * 60 * 60 * 1_000)
  const credentials = await generate([{ name: 'commonName', value: TLS_TEST_HOSTS[0] }], {
    algorithm: 'sha256',
    keyType: 'rsa',
    keySize: 2048,
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
        keyCertSign: true,
        cRLSign: true,
        critical: true
      },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: TLS_TEST_HOSTS.map((value) => ({ type: 2 as const, value }))
      }
    ]
  })
  return { key: credentials.private, cert: credentials.cert }
}
