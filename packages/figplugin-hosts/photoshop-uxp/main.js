const { app } = require('photoshop')
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
    host: 'photoshop',
    nodes: [],
    truncated: false
  }

  try {
    const activeDocument = app.activeDocument
    if (!activeDocument) return empty
    const layers = activeDocument.activeLayers
    const nodes = []
    for (let index = 0; index < Math.min(layers.length, MAX_SELECTION); index += 1) {
      const layer = layers[index]
      const id = layer.id
      nodes.push({
        id: Number.isSafeInteger(id) && id >= 0 ? id : null,
        kind: safeLabel(layer.kind),
        name: safeLabel(layer.name),
        locked: layer.allLocked === true
      })
    }
    return { ...empty, nodes, truncated: layers.length > MAX_SELECTION }
  } catch {
    // No open document or a stale selection: no exception details or partial snapshot.
    return empty
  }
}

const output = document.getElementById('selection')
document.getElementById('read-selection').addEventListener('click', () => {
  output.textContent = JSON.stringify(selectionContext(), null, 2)
})
