import { createAdapter, objectSchema, optionalPathOrUrlSchema } from './helpers'

export const videoToolAdapter = createAdapter([
  {
    name: 'video.inspect',
    category: 'video',
    description: 'Inspect video metadata through a registered video adapter.',
    inputSchema: optionalPathOrUrlSchema,
    dependency: 'videoInspect'
  },
  {
    name: 'video.create',
    category: 'video',
    description: 'Create or transform video through a registered video adapter.',
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
    dependency: 'videoCreate',
    permissionLevel: 'write',
    requiresConfirmation: true,
    disabledByDefault: true
  }
])
