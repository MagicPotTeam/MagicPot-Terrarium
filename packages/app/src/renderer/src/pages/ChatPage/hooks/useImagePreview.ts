import { useState, useCallback, useRef, useMemo, useEffect } from 'react'

/**
 * 图片预览状态管理 Hook
 * 管理全屏预览的打开/关闭、缩放、拖拽、键盘/滚轮导航
 */
export function useImagePreview(aiImageList: string[], active: boolean = true) {
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [imageScale, setImageScale] = useState(1)
  const [imagePosition, setImagePosition] = useState({ x: 0, y: 0 })
  const [isPreviewDragging, setIsPreviewDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const hasDraggedRef = useRef(false)

  const closePreview = useCallback(() => {
    setPreviewImage(null)
    setImageScale(1)
    setImagePosition({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    if (active) return
    closePreview()
    setIsPreviewDragging(false)
  }, [active, closePreview])

  const currentImageIndex = useMemo(() => {
    if (!previewImage) return -1
    return aiImageList.indexOf(previewImage)
  }, [previewImage, aiImageList])

  const navigateImage = useCallback(
    (direction: 'prev' | 'next') => {
      if (aiImageList.length === 0) return
      let newIndex: number
      if (currentImageIndex === -1) {
        newIndex = direction === 'next' ? 0 : aiImageList.length - 1
      } else {
        newIndex =
          direction === 'next'
            ? (currentImageIndex + 1) % aiImageList.length
            : (currentImageIndex - 1 + aiImageList.length) % aiImageList.length
      }
      setPreviewImage(aiImageList[newIndex])
      setImageScale(1)
      setImagePosition({ x: 0, y: 0 })
    },
    [aiImageList, currentImageIndex]
  )

  const handlePreviewMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 0) {
        e.preventDefault()
        e.stopPropagation()
        setIsPreviewDragging(true)
        hasDraggedRef.current = false
        setDragStart({ x: e.clientX - imagePosition.x, y: e.clientY - imagePosition.y })
      }
    },
    [imagePosition]
  )

  const handlePreviewMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isPreviewDragging) {
        e.preventDefault()
        hasDraggedRef.current = true
        setImagePosition({
          x: e.clientX - dragStart.x,
          y: e.clientY - dragStart.y
        })
      }
    },
    [isPreviewDragging, dragStart]
  )

  const handlePreviewMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (isPreviewDragging) {
        e.stopPropagation()
        setIsPreviewDragging(false)
      }
    },
    [isPreviewDragging]
  )

  const handlePreviewClick = useCallback(
    (_e: React.MouseEvent) => {
      if (hasDraggedRef.current) {
        hasDraggedRef.current = false
        return
      }
      closePreview()
    },
    [closePreview]
  )

  const handlePreviewWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey) {
        const delta = e.deltaY > 0 ? -0.1 : 0.1
        setImageScale((prev) => Math.min(Math.max(0.1, prev + delta), 5))
      } else {
        if (e.deltaY > 0) {
          navigateImage('next')
        } else {
          navigateImage('prev')
        }
      }
    },
    [navigateImage]
  )

  // 键盘导航 (左右箭头 + Escape)
  useEffect(() => {
    if (!active) return
    if (!previewImage) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        navigateImage('prev')
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        navigateImage('next')
      } else if (e.key === 'Escape') {
        closePreview()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [active, previewImage, navigateImage, closePreview])

  return {
    previewImage,
    setPreviewImage,
    imageScale,
    imagePosition,
    isPreviewDragging,
    currentImageIndex,
    closePreview,
    navigateImage,
    handlePreviewMouseDown,
    handlePreviewMouseMove,
    handlePreviewMouseUp,
    handlePreviewClick,
    handlePreviewWheel
  }
}
