import { objectSchema } from './helpers'

export const configuredLocalFileSchema = objectSchema(
  {
    path: {
      type: 'string',
      description:
        'Absolute local file path inside a configured project, output, managed media or model directory.'
    }
  },
  ['path'],
  false
)

export const executableWorkflowSchema = objectSchema(
  {
    workflow: {
      type: 'object',
      description:
        'ComfyUI API-format prompt: node IDs mapped to objects containing class_type and inputs.'
    },
    prompt: {
      type: 'object',
      description:
        'Alias for workflow; plain-text prompts and frontend nodes/links graphs are not executable workflows.'
    },
    qAppKey: {
      type: 'string',
      description: 'Use the saved executable workflow from this quick app when workflow is omitted.'
    },
    workflowId: {
      type: 'string',
      description:
        'Relative JSON filename in the configured workflow directory, used when workflow and qAppKey are omitted.'
    }
  },
  undefined,
  false
)
