import { describe, expect, it } from 'vitest'
import { bundledCreativeDeclarations } from './bundledCreativeDeclarations'

const names = ['comfyui.status', 'comfyui.queue', 'comfyui.workflow.submit', 'qapp.list', 'qapp.get', 'canvas.status', 'canvas.export', 'image.inspect', 'image.create', 'video.inspect', 'video.create', 'model.list', 'model.inspect', 'model.status', 'asset.list', 'asset.import', 'project.trace.list', 'project.trace.read', 'mcp.status', 'mcp.tool.call', 'terminal.run']
const categories = new Set(['comfyui', 'qapp', 'canvas', 'image', 'video', 'model', 'asset', 'projectTrace', 'mcp', 'terminal'])

describe('bundled creative declarations, not live readiness or permission', () => {
  it('contains exactly the 21 existing adapter declarations in stable order', () => {
    expect(Object.keys(bundledCreativeDeclarations)).toEqual(names)
    expect(new Set(Object.keys(bundledCreativeDeclarations)).size).toBe(21)
  })
  it.each(names)('contains only frozen bounded public strings for %s', name => {
    const row = bundledCreativeDeclarations[name]
    expect(row).toBeDefined()
    expect(Object.keys(row)).toEqual(['name', 'category', 'description'])
    expect(row.name).toBe(name); expect(categories.has(row.category)).toBe(true)
    expect(row.name.length).toBeLessThanOrEqual(80); expect(row.category.length).toBeLessThanOrEqual(16)
    expect(row.description.trim()).toBe(row.description); expect(row.description.length).toBeGreaterThan(0); expect(row.description.length).toBeLessThanOrEqual(1000)
    expect([...row.description].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)).toBe(true)
    expect(Object.isFrozen(row)).toBe(true)
    expect(Reflect.set(row, 'status', 'available')).toBe(false)
    expect(Reflect.set(row, 'description', 'forged')).toBe(false)
  })
  it('exposes a frozen keyed record and bounded JSON data only', () => {
    expect(Object.isFrozen(bundledCreativeDeclarations)).toBe(true)
    expect(Reflect.set(bundledCreativeDeclarations, 'injected', { name: 'evil' })).toBe(false)
    const wire = JSON.stringify(bundledCreativeDeclarations)
    expect(wire.length).toBeLessThanOrEqual(131072)
    expect(JSON.parse(wire)).toEqual(bundledCreativeDeclarations)
    expect(wire).not.toMatch(/inputSchema|dependency|permissionLevel|requiresConfirmation|disabledByDefault|unavailableReason|"status"/)
  })
})
