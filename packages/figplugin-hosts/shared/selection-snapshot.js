;(function () {
  'use strict'

  // Local metadata only: no attestation, revision, exclusion or write precondition.
  if (Object.getOwnPropertyDescriptor(globalThis, 'MagicPotSelectionSnapshotV1')) return
  const MAX_SELECTION = 100
  const MAX_NODES = 512
  const MAX_DEPTH = 32
  const MAX_NAME_BYTES = 4096
  const MAX_BYTES = 256 * 1024
  const MAX_EPOCH_COUNTER = 999999999999999
  const faults = new Map()
  const fail = (code) => {
    if (!faults.has(code)) faults.set(code, Object.freeze({ code }))
    throw faults.get(code)
  }
  const safeError = (error) => {
    // Never inspect native errors: they can contain names, paths or throwing accessors.
    for (const [code, fault] of faults) {
      if (error === fault) return { ok: false, error: { code } }
    }
    return { ok: false, error: { code: 'CAPTURE_FAILED' } }
  }
  const object = (value) => {
    if (value === null || typeof value !== 'object') fail('INVALID_HOST_DATA')
    return value
  }
  const utf8Bytes = (text, max) => {
    if (typeof text !== 'string') fail('INVALID_HOST_DATA')
    if (text.length > max) fail('FIELD_TOO_LARGE')
    let bytes = 0
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = text.charCodeAt(++index)
        if (!(low >= 0xdc00 && low <= 0xdfff)) fail('INVALID_UNICODE')
        bytes += 4
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        fail('INVALID_UNICODE')
      } else {
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3
      }
      if (bytes > max) fail('FIELD_TOO_LARGE')
    }
    return bytes
  }
  const text = (value, max, nonempty) => {
    utf8Bytes(value, max)
    if (nonempty && value.length === 0) fail('INVALID_HOST_DATA')
    return value
  }
  const bool = (value) => {
    if (typeof value !== 'boolean') fail('UNKNOWN_STATE')
    return value
  }
  const id = (value, host) => {
    if (host === 'photoshop') {
      if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_ID')
      return String(value)
    }
    return text(value, 256, true)
  }
  const collectionLength = (value, max, code) => {
    object(value)
    const length = value.length
    if (!Number.isSafeInteger(length) || length < 0) fail('INVALID_HOST_DATA')
    if (length > max) fail(code)
    return length
  }
  const capabilities = () => ({
    readSnapshot: true,
    writeCommands: [],
    authenticatedHost: false,
    nativeDocumentRevision: false,
    mutationExclusion: false,
    rollback: false,
    remoteMutationTracking: false
  })

  function createReader(options, host) {
    let native
    let instanceEpoch
    let setupError
    try {
      object(options)
      instanceEpoch = options.instanceEpoch
      if (typeof instanceEpoch !== 'string' || !/^[a-f0-9]{32}$(?![\s\S])/.test(instanceEpoch)) {
        fail('INVALID_INSTANCE_EPOCH')
      }
      native = object(host === 'figma' ? options.figma : options.app)
    } catch (error) {
      setupError = safeError(error)
    }
    let sequence = 0
    let epochCounter = 0
    let openDocuments = new Map()
    let observedRoot
    let observedRootId

    function capture() {
      if (setupError) return { ok: false, error: { code: setupError.error.code } }
      try {
        if (sequence === Number.MAX_SAFE_INTEGER) fail('COUNTER_EXHAUSTED')
        sequence += 1
        let root
        let page
        let pageId = null
        let documentId
        let openEpoch
        let selection
        if (host === 'figma') {
          root = object(native.root)
          if (root.type !== 'DOCUMENT') fail('WRONG_OWNERSHIP')
          documentId = id(root.id, host)
          if (observedRoot && (observedRoot !== root || observedRootId !== documentId)) {
            fail('WRONG_OWNERSHIP')
          }
          page = object(native.currentPage)
          pageId = id(page.id, host)
          if (pageId === documentId || page.type !== 'PAGE') fail('WRONG_OWNERSHIP')
          const pageRoot = object(page.parent)
          if (pageRoot !== root || id(pageRoot.id, host) !== documentId) fail('WRONG_OWNERSHIP')
          selection = page.selection
          openEpoch = instanceEpoch + ':1'
        } else {
          // Photoshop 23.3+ DOM: observe open IDs only, never document paths or contents.
          // A close/reopen between observations is unknowable; this is not host-guaranteed.
          const documents = native.documents
          const count = collectionLength(documents, 1000, 'DOCUMENTS_TOO_LARGE')
          const present = new Set()
          const next = new Map()
          let counter = epochCounter
          for (let index = 0; index < count; index += 1) {
            const document = object(documents[index])
            const key = id(document.id, host)
            if (present.has(key)) fail('DUPLICATE_ID')
            present.add(key)
            let value = openDocuments.get(key)
            if (value === undefined) {
              if (counter === MAX_EPOCH_COUNTER) fail('COUNTER_EXHAUSTED')
              value = instanceEpoch + ':' + ++counter
            }
            next.set(key, value)
          }
          // Observed absence retires an epoch even when there is no active document.
          openDocuments = next
          epochCounter = counter
          const document = native.activeDocument
          if (document === null) fail('NO_DOCUMENT')
          object(document)
          documentId = id(document.id, host)
          if (!present.has(documentId)) fail('WRONG_OWNERSHIP')
          openEpoch = next.get(documentId)
          selection = document.activeLayers
        }
        // Inspect length before materializing or accessing even the first native item.
        const count = collectionLength(selection, MAX_SELECTION, 'SELECTION_TOO_LARGE')
        const nodes = []
        const entries = new Map()
        const objects = new WeakMap()
        const selected = []
        const selectedIds = new Set()
        const readNode = (value) => {
          object(value)
          const cached = objects.get(value)
          if (cached) return cached
          const key = id(value.id, host)
          if (host === 'figma' && key === documentId) fail('DUPLICATE_ID')
          if (entries.has(key)) fail('DUPLICATE_ID')
          if (nodes.length === MAX_NODES) fail('TOO_MANY_NODES')
          let kind
          let role = 'scene'
          let visible
          let locked
          let parent
          if (host === 'figma') {
            kind = text(value.type, 128, true)
            if (kind === 'PAGE') {
              if (value !== page || key !== pageId || value.parent !== root) fail('WRONG_OWNERSHIP')
              role = 'structural'
              visible = null
              locked = null
              parent = null
            } else {
              if (value === page || kind === 'DOCUMENT') fail('WRONG_OWNERSHIP')
              visible = bool(value.visible)
              locked = bool(value.locked)
              parent = object(value.parent)
            }
          } else {
            // Layer.parent is Layer|null, NOT a Document sentinel. Layer/document IDs
            // occupy separate namespaces: a layer ID equal to documentId is legitimate.
            if (id(object(value.document).id, host) !== documentId) fail('WRONG_OWNERSHIP')
            kind = text(value.kind, 128, true)
            visible = bool(value.visible)
            const locks = [
              bool(value.allLocked),
              bool(value.pixelsLocked),
              bool(value.positionLocked),
              bool(value.transparentPixelsLocked),
              bool(value.isBackgroundLayer)
            ]
            locked = locks.some((flag) => flag)
            parent = value.parent
            if (parent !== null) object(parent)
          }
          const node = {
            id: key,
            parentId: parent === null ? null : id(parent.id, host),
            kind,
            name: text(value.name, MAX_NAME_BYTES, false),
            role,
            visible,
            locked
          }
          const entry = { node, parent }
          entries.set(key, entry)
          objects.set(value, entry)
          nodes.push(node)
          return entry
        }
        for (let index = 0; index < count; index += 1) {
          const target = readNode(selection[index])
          if (target.node.role !== 'scene') fail('WRONG_OWNERSHIP')
          if (selectedIds.has(target.node.id)) fail('DUPLICATE_SELECTION')
          selectedIds.add(target.node.id)
          const ancestors = []
          const seen = new Set([target.node.id])
          let effectiveLocked = target.node.locked
          let effectiveVisible = target.node.visible
          let current = target
          while (current.parent !== null) {
            if (ancestors.length === MAX_DEPTH) fail('ANCESTRY_TOO_DEEP')
            const parent = readNode(current.parent)
            if (parent.node.id !== current.node.parentId) fail('WRONG_OWNERSHIP')
            if (seen.has(parent.node.id)) fail('CYCLIC_ANCESTRY')
            seen.add(parent.node.id)
            ancestors.push(parent.node.id)
            if (parent.node.role === 'scene') {
              effectiveLocked = effectiveLocked || parent.node.locked
              effectiveVisible = effectiveVisible && parent.node.visible
            }
            current = parent
          }
          if (host === 'figma' && current.node.id !== pageId) fail('WRONG_OWNERSHIP')
          selected.push({ id: target.node.id, ancestors, effectiveLocked, effectiveVisible })
        }
        if (host === 'figma') {
          if (
            native.root !== root ||
            id(root.id, host) !== documentId ||
            native.currentPage !== page ||
            id(page.id, host) !== pageId ||
            page.parent !== root
          )
            fail('WRONG_OWNERSHIP')
        } else if (id(object(native.activeDocument).id, host) !== documentId) {
          fail('WRONG_OWNERSHIP')
        }
        const snapshot = {
          protocol: 1,
          purpose: 'read-only-selection-review',
          host,
          complete: true,
          document: {
            id: documentId,
            idSource: host === 'figma' ? 'figma-plugin-root' : 'photoshop-open-document',
            openEpoch,
            openEpochSource: 'plugin-observation',
            pageId
          },
          observation: { sequence, source: 'capture-counter' },
          capabilities: capabilities(),
          nodes,
          selected
        }
        const json = JSON.stringify(snapshot)
        // JSON escaping (especially controls) counts towards the complete limit.
        try {
          utf8Bytes(json, MAX_BYTES)
        } catch (error) {
          if (error === faults.get('FIELD_TOO_LARGE')) fail('SNAPSHOT_TOO_LARGE')
          throw error
        }
        if (host === 'figma') {
          observedRoot = root
          observedRootId = documentId
        }
        return { ok: true, snapshot }
      } catch (error) {
        return safeError(error)
      }
    }
    return Object.freeze({ capture })
  }
  Object.defineProperty(globalThis, 'MagicPotSelectionSnapshotV1', {
    value: Object.freeze({
      createFigmaReader: (options) => createReader(options, 'figma'),
      createPhotoshopReader: (options) => createReader(options, 'photoshop')
    }),
    writable: false,
    configurable: false,
    enumerable: false
  })
})()
