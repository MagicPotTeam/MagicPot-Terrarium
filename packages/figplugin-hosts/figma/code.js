const MAX_SELECTION = 100

function safeLabel(value) {
  if (typeof value !== 'string') return ''
  return value
    .slice(0, 120)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
}

function selectionContext() {
  const empty = {
    kind: 'selection-context',
    protocol: 1,
    host: 'figma',
    nodes: [],
    truncated: false
  }

  try {
    const selection = figma.currentPage.selection
    const nodes = []
    for (let index = 0; index < Math.min(selection.length, MAX_SELECTION); index += 1) {
      const node = selection[index]
      const geometry = {}
      for (const key of ['x', 'y', 'width', 'height', 'rotation']) {
        const value = node[key]
        if (typeof value === 'number' && Number.isFinite(value)) geometry[key] = value
      }
      nodes.push({
        id: safeLabel(node.id),
        type: safeLabel(node.type),
        name: safeLabel(node.name),
        locked: node.locked === true,
        geometry
      })
    }
    return { ...empty, nodes, truncated: selection.length > MAX_SELECTION }
  } catch {
    // A stale selection must not expose host exception details or a partial snapshot.
    return empty
  }
}

figma.showUI(__html__, { width: 380, height: 520 })

figma.ui.onmessage = (message) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return
  // Accept only a payload-free command; never stringify or inspect arbitrary nested input.
  const keys = Object.keys(message)
  if (keys.length !== 1 || keys[0] !== 'type') return
  if (typeof message.type !== 'string' || message.type.length > 32) return
  if (message.type === 'read-selection') {
    figma.ui.postMessage(selectionContext())
  } else if (message.type === 'close') {
    figma.closePlugin()
  }
}
