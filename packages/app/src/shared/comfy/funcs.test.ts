import { describe, expect, it } from 'vitest'
import {
  fileItemToValue,
  findNotInstalledNodeInfo,
  normalizeExecutableWorkflow,
  parseAllNodeIdAndField,
  valueToFileItem
} from './funcs'
import { ObjectInfoMap, Workflow } from './types'

describe('valueToFileItem', () => {
  it('should return the correct file item', () => {
    expect(valueToFileItem('spaceship-launch.jpg')).toEqual({
      filename: 'spaceship-launch.jpg',
      type: 'input'
    })
    expect(valueToFileItem('clipspace/clipspace-mask-217369.89999961853.png [input]')).toEqual({
      filename: 'clipspace-mask-217369.89999961853.png',
      type: 'input',
      subfolder: 'clipspace'
    })
  })
})

describe('fileItemToValue', () => {
  it('should return the correct value', () => {
    expect(fileItemToValue({ filename: 'spaceship-launch.jpg', type: 'input' })).toEqual(
      'spaceship-launch.jpg'
    )
    expect(
      fileItemToValue({
        filename: 'clipspace-mask-217369.89999961853.png',
        type: 'input',
        subfolder: 'clipspace'
      })
    ).toEqual('clipspace/clipspace-mask-217369.89999961853.png [input]')
  })
})

describe('findNotInstalledNodeCls', () => {
  it('should return the correct not installed node class type list', () => {
    const workflow: Workflow = {
      node1: { class_type: 'Node1', inputs: {} },
      node2: { class_type: 'Node2', inputs: {} }
    }
    const objectInfos: ObjectInfoMap = {
      Node3: { input: { required: { field1: ['CLIP', {}] } } },
      Node4: { input: { required: { field2: ['CLIP', {}] } } }
    }
    expect(findNotInstalledNodeInfo(workflow, objectInfos)).toEqual(['Node1', 'Node2'])
  })
  it('should return empty list when there is no not installed node', () => {
    const workflow: Workflow = {
      node1: { class_type: 'Node1', inputs: {} },
      node2: { class_type: 'Node2', inputs: {} }
    }
    const objectInfos: ObjectInfoMap = {
      Node1: { input: { required: { field1: ['CLIP', {}] } } },
      Node2: { input: { required: { field2: ['CLIP', {}] } } }
    }
    expect(findNotInstalledNodeInfo(workflow, objectInfos)).toEqual([])
  })
  it('should exclude ComfyUI built-in nodes like Note and Reroute', () => {
    const workflow: Workflow = {
      node1: { class_type: 'Node1', inputs: {} },
      node2: { class_type: 'Note', inputs: {} },
      node3: { class_type: 'Reroute', inputs: {} }
    }
    const objectInfos: ObjectInfoMap = {
      Node3: { input: { required: { field1: ['CLIP', {}] } } }
    }
    // Note 和 Reroute 应该被排除，只有 Node1 应该被标记为未安装
    expect(findNotInstalledNodeInfo(workflow, objectInfos)).toEqual(['Node1'])
  })
})

describe('normalizeExecutableWorkflow', () => {
  it('removes Note nodes before a workflow is submitted', () => {
    const workflow: Workflow = {
      '1': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
      '18': { class_type: 'Note', inputs: { value: 'This is a UI-only note.' } },
      '5': { class_type: 'SaveImage', inputs: { images: ['1', 0] } }
    }

    expect(normalizeExecutableWorkflow(workflow)).toEqual({
      '1': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
      '5': { class_type: 'SaveImage', inputs: { images: ['1', 0] } }
    })
  })

  it('removes Reroute nodes and reconnects downstream inputs to their source', () => {
    const workflow: Workflow = {
      '1': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
      '2': { class_type: 'Reroute', inputs: { input: ['1', 0] } },
      '3': { class_type: 'Reroute', inputs: { input: ['2', 0] } },
      '5': { class_type: 'SaveImage', inputs: { images: ['3', 0] } }
    }

    expect(normalizeExecutableWorkflow(workflow)).toEqual({
      '1': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
      '5': { class_type: 'SaveImage', inputs: { images: ['1', 0] } }
    })
  })
})

describe('parseAllNodeIdAndField', () => {
  it('does not offer UI-only nodes as selectable workflow inputs', () => {
    const workflow: Workflow = {
      '1': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
      '18': { class_type: 'Note', inputs: { value: 'This is a UI-only note.' } }
    }

    expect(parseAllNodeIdAndField(workflow)).toEqual([{ nodeId: '1', field: 'image' }])
  })
})
