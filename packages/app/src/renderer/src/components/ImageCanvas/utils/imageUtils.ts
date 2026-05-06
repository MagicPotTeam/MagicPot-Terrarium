/**
 * 图像通道分离工具函数
 */

/**
 * 从图像 URL 加载图像并分离 RGB 和 Alpha 通道
 * @param imageUrl 图像 URL
 * @returns Promise<{rgbImage: HTMLImageElement, alphaImage: HTMLImageElement}>
 */
export async function separateImageChannels(
  imageUrl: string,
  maskColor: string
): Promise<{
  rgbImage: HTMLImageElement
  alphaImage: HTMLImageElement
}> {
  const maskColorRgb: { r: number; g: number; b: number } = {
    r: parseInt(maskColor.slice(1, 3), 16),
    g: parseInt(maskColor.slice(3, 5), 16),
    b: parseInt(maskColor.slice(5, 7), 16)
  }
  const img = await loadImage(imageUrl)
  // 创建 canvas 来处理图像
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')

  if (!ctx) {
    throw new Error('无法获取 canvas 上下文')
  }

  canvas.width = img.width
  canvas.height = img.height

  // 绘制原图像到 canvas
  ctx.drawImage(img, 0, 0)

  // 获取图像数据
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = imageData.data

  // 创建 RGB 图像数据（移除 alpha 通道）
  const rgbData = new Uint8ClampedArray(data.length)
  for (let i = 0; i < data.length; i += 4) {
    rgbData[i] = data[i] // R
    rgbData[i + 1] = data[i + 1] // G
    rgbData[i + 2] = data[i + 2] // B
    rgbData[i + 3] = 255 // A (设为不透明)
  }

  // 创建 Alpha 通道图像数据（以红色显示 alpha 为 0 的部分）
  const alphaData = new Uint8ClampedArray(data.length)
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]
    if (alpha === 0) {
      // Alpha 为 0 的部分显示为红色
      alphaData[i] = maskColorRgb.r // R
      alphaData[i + 1] = maskColorRgb.g // G
      alphaData[i + 2] = maskColorRgb.b // B
      alphaData[i + 3] = 255 // A
    } else {
      // Alpha 不为 0 的部分设为透明
      alphaData[i] = 0 // R
      alphaData[i + 1] = 0 // G
      alphaData[i + 2] = 0 // B
      alphaData[i + 3] = 0 // A
    }
  }

  // 创建 RGB 图像
  const rgbImageData = new ImageData(rgbData, canvas.width, canvas.height)
  const rgbCanvas = document.createElement('canvas')
  const rgbCtx = rgbCanvas.getContext('2d')
  if (!rgbCtx) {
    throw new Error('无法创建 RGB canvas 上下文')
  }
  rgbCanvas.width = canvas.width
  rgbCanvas.height = canvas.height
  rgbCtx.putImageData(rgbImageData, 0, 0)

  // 创建 Alpha 图像
  const alphaImageData = new ImageData(alphaData, canvas.width, canvas.height)
  const alphaCanvas = document.createElement('canvas')
  const alphaCtx = alphaCanvas.getContext('2d')
  if (!alphaCtx) {
    throw new Error('无法创建 Alpha canvas 上下文')
  }
  alphaCanvas.width = canvas.width
  alphaCanvas.height = canvas.height
  alphaCtx.putImageData(alphaImageData, 0, 0)

  // 将 canvas 转换为 HTMLImageElement
  const rgbImage = await loadImage(rgbCanvas.toDataURL())
  const alphaImage = await loadImage(alphaCanvas.toDataURL())

  return { rgbImage, alphaImage }
}

/**
 * 检查图像是否有 Alpha 通道
 * @param imageUrl 图像 URL
 * @returns Promise<boolean>
 */
export async function hasAlphaChannel(imageUrl: string): Promise<boolean> {
  const img = await loadImage(imageUrl)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')

  if (!ctx) {
    throw new Error('无法获取 canvas 上下文')
  }

  canvas.width = img.width
  canvas.height = img.height
  ctx.drawImage(img, 0, 0)

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = imageData.data

  // 检查是否有任何像素的 alpha 值小于 255
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) {
      return true
    }
  }

  return false
}

export async function loadImage(imageUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      resolve(img)
    }
    img.onerror = () => {
      reject(new Error('图像加载失败'))
    }
    img.src = imageUrl
  })
}
