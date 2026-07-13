import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function assertInsideRoot(root, targetPath, label) {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(targetPath)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the staged source tree: ${resolvedTarget}`)
  }
  return resolvedTarget
}

function toGitRelativePath(root, targetPath) {
  const relative = path.relative(root, targetPath)
  return relative ? relative.split(path.sep).join('/') : ''
}

function readGitSymlinkEntries(root) {
  const tree = execFileSync(
    'git',
    [
      'ls-tree',
      '-r',
      '-z',
      '--format=%(objectmode) %(objecttype) %(objectname)%x00%(path)',
      'HEAD'
    ],
    {
      cwd: root,
      encoding: 'utf8'
    }
  )

  const records = tree.split('\0')
  const entries = []
  for (let index = 0; index < records.length - 1; index += 2) {
    const metadata = records[index]
    const relativePath = records[index + 1]
    const [mode, type, objectId] = metadata.split(' ')
    if (!mode || !type || !objectId || !relativePath) {
      throw new Error(`Unexpected git ls-tree record near index ${index}`)
    }
    if (mode === '120000') {
      if (type !== 'blob') {
        throw new Error(`Unexpected Git symlink entry: ${metadata} ${relativePath}`)
      }
      entries.push({ objectId, relativePath })
    }
  }

  return entries
}

function resolveMaterializedTarget(entry, entriesByRelativePath, root, visiting = new Set()) {
  if (visiting.has(entry.relativePath)) {
    throw new Error(`Git symlink cycle detected at ${entry.relativePath}`)
  }

  const linkPath = assertInsideRoot(
    root,
    path.resolve(root, ...entry.relativePath.split('/')),
    `Git symlink ${entry.relativePath}`
  )
  const linkTarget = execFileSync('git', ['cat-file', 'blob', entry.objectId], {
    cwd: root,
    encoding: 'utf8'
  })

  if (!linkTarget || linkTarget.includes('\0')) {
    throw new Error(`Git symlink has an invalid target: ${entry.relativePath}`)
  }
  if (path.isAbsolute(linkTarget) || path.win32.isAbsolute(linkTarget)) {
    throw new Error(`Git symlink target must be relative: ${entry.relativePath} -> ${linkTarget}`)
  }

  let targetPath = assertInsideRoot(
    root,
    path.resolve(path.dirname(linkPath), linkTarget),
    `Git symlink target ${entry.relativePath} -> ${linkTarget}`
  )
  let targetEntry = entriesByRelativePath.get(toGitRelativePath(root, targetPath))
  if (!targetEntry && path.sep === '\\' && linkTarget.includes('/')) {
    const posixTargetPath = assertInsideRoot(
      root,
      path.resolve(path.dirname(linkPath), ...linkTarget.split('/')),
      `Git symlink target ${entry.relativePath} -> ${linkTarget}`
    )
    const posixTargetEntry = entriesByRelativePath.get(toGitRelativePath(root, posixTargetPath))
    if (posixTargetEntry || fs.existsSync(posixTargetPath)) {
      targetPath = posixTargetPath
      targetEntry = posixTargetEntry
    }
  }
  if (targetEntry) {
    const nextVisiting = new Set(visiting)
    nextVisiting.add(entry.relativePath)
    return {
      ...resolveMaterializedTarget(targetEntry, entriesByRelativePath, root, nextVisiting),
      linkPath,
      linkTarget
    }
  }

  const realTargetPath = assertInsideRoot(
    root,
    fs.realpathSync(targetPath),
    `Resolved Git symlink target ${entry.relativePath} -> ${linkTarget}`
  )
  const targetStat = fs.statSync(realTargetPath)
  if (!targetStat.isFile()) {
    throw new Error(`Git symlink target is not a file: ${entry.relativePath} -> ${linkTarget}`)
  }

  return { linkPath, linkTarget, realTargetPath, targetMode: targetStat.mode }
}

export function materializeGitFileSymlinks(root) {
  const resolvedRoot = path.resolve(root)
  const entries = readGitSymlinkEntries(resolvedRoot)
  const entriesByRelativePath = new Map(entries.map((entry) => [entry.relativePath, entry]))

  for (const entry of entries) {
    const { linkPath, linkTarget, realTargetPath, targetMode } = resolveMaterializedTarget(
      entry,
      entriesByRelativePath,
      resolvedRoot
    )
    const linkStat = fs.lstatSync(linkPath, { throwIfNoEntry: false })
    if (linkStat) {
      if (linkStat.isDirectory() && !linkStat.isSymbolicLink()) {
        throw new Error(`Git symlink checkout became a directory: ${entry.relativePath}`)
      }
      fs.rmSync(linkPath, { force: true, recursive: false })
    }

    fs.copyFileSync(realTargetPath, linkPath)
    fs.chmodSync(linkPath, targetMode)
    console.log(
      `[prepare-embedded-staging] Materialized Git file symlink: ${entry.relativePath} -> ${linkTarget}`
    )
  }

  return entries.length
}
