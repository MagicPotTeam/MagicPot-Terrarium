import { createAdapter, objectSchema, optionalPathOrUrlSchema } from './helpers'

export const imageToolAdapter = createAdapter([
  {
    name: 'image.inspect',
    category: 'image',
    description: 'Inspect image metadata through a registered image adapter.',
    inputSchema: optionalPathOrUrlSchema,
    dependency: 'imageInspect'
  },
  {
    name: 'image.create',
    category: 'image',
    description: 'Create or transform an image through a registered image generation adapter.',
    inputSchema: objectSchema({
      prompt: {
        type: 'string'
      },
      sourcePath: {
        type: 'string'
      },
      outputDir: {
        type: 'string'
      }
    }),
    dependency: 'imageCreate',
    permissionLevel: 'write',
    requiresConfirmation: true,
    disabledByDefault: true
  }
])
