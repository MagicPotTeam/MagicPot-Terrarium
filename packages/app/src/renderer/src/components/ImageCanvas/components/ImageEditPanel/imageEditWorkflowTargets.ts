export type ImageEditWorkflowTarget = {
  key: string
  title: string
  description: string
  entryLabel: string
  launchLabel: string
}

export const canLaunchImageEditWorkflow = (workflow: ImageEditWorkflowTarget) =>
  workflow.key.trim().length > 0

export const IMAGE_PERSPECTIVE_WORKFLOW: ImageEditWorkflowTarget = {
  key: 'Qwen_多角度相机',
  title: 'Image perspective / lighting',
  description:
    'The shipped multi-angle template includes the Lightning LoRA, angle controls, and zoom controls for image-side perspective and lighting edits.',
  entryLabel: 'Image-side workflow',
  launchLabel: 'Open image workflow in designer'
}

export const VIDEO_PERSPECTIVE_WORKFLOW: ImageEditWorkflowTarget = {
  key: 'Wan2_2_I2V',
  title: 'Video perspective / lighting',
  description:
    'The shipped Wan 2.2 image-to-video template is the current video-side workflow entry, so the panel opens a real shipped video workflow instead of a stub.',
  entryLabel: 'Video-side workflow',
  launchLabel: 'Open video workflow in designer'
}

export const getImageEditWorkflowUnavailableLabel = (workflow: ImageEditWorkflowTarget): string =>
  `${workflow.title} is unavailable until its shipped Quick App template can be loaded.`
