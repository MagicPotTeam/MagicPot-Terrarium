#!/usr/bin/env node
import { lstatSync, unlinkSync } from 'node:fs'

const [command, ...args] = process.argv.slice(2)
const values = new Map()
for (let index = 0; index < args.length; index += 2) values.set(args[index], args[index + 1])
const path = values.get('--path')
try {
  if (command === 'inspect-file') {
    const stat = lstatSync(path, { bigint: true })
    if (stat.isSymbolicLink() || !stat.isFile()) process.exitCode = 4
    else console.log(JSON.stringify({ status: 'inspected', volumeSerial: stat.dev.toString(), fileIndex: stat.ino.toString() }))
  } else if (command === 'delete-file') {
    const stat = lstatSync(path, { bigint: true })
    if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== BigInt(values.get('--volume-serial')) || stat.ino !== BigInt(values.get('--file-index'))) {
      console.log(JSON.stringify({ status: 'deleted-foreign-preserved' }))
    } else {
      unlinkSync(path)
      console.log(JSON.stringify({ status: 'deleted' }))
    }
  } else process.exitCode = 2
} catch (error) {
  if (command === 'delete-file' && error?.code === 'ENOENT') console.log(JSON.stringify({ status: 'deleted' }))
  else process.exitCode = 2
}
