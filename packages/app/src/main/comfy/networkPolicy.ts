import { BlockList, isIP } from 'node:net'

const UNSAFE_COMFY_ADDRESSES = new BlockList()

const addIpv4 = (address: string, prefix: number): void =>
  UNSAFE_COMFY_ADDRESSES.addSubnet(address, prefix, 'ipv4')
const addMappedIpv4 = (address: string, prefix: number): void =>
  UNSAFE_COMFY_ADDRESSES.addSubnet(`::ffff:${address}`, 96 + prefix, 'ipv6')

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  addIpv4(address, prefix)
  addMappedIpv4(address, prefix)
}

UNSAFE_COMFY_ADDRESSES.addSubnet('::', 96, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addAddress('::1', 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('64:ff9b::', 96, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('64:ff9b:1::', 48, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('100::', 64, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('100:0:0:1::', 64, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('2001::', 23, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('2001:db8::', 32, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('2002::', 16, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('2620:4f:8000::', 48, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('3fff::', 20, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('5f00::', 16, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('fc00::', 7, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('fec0::', 10, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('fe80::', 10, 'ipv6')
UNSAFE_COMFY_ADDRESSES.addSubnet('ff00::', 8, 'ipv6')

export const isUnsafeComfyAddress = (address: string): boolean => {
  const family = isIP(address)
  return family !== 0 && UNSAFE_COMFY_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6')
}
