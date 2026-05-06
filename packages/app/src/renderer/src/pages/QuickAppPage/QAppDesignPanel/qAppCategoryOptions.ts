import type { QAppCategory } from '@shared/qApp/category'

type Translate = (key: string, options?: { defaultValue?: string }) => string

export const getQAppCategoryOptions = (
  t: Translate
): Array<{ value: QAppCategory; label: string }> => [
  {
    value: 'image',
    label: t('qapp.design.save.category_image', { defaultValue: '图片' })
  },
  {
    value: 'video',
    label: t('qapp.design.save.category_video', { defaultValue: '视频' })
  },
  {
    value: 'model3d',
    label: t('qapp.design.save.category_model3d', { defaultValue: '3D' })
  },
  {
    value: 'inspection',
    label: t('qapp.design.save.category_inspection', { defaultValue: '检查' })
  }
]
