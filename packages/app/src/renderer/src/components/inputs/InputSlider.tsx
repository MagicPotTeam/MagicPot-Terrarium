// 导入 React 核心库和相关 Hooks
import React, { useState, useEffect, useCallback } from 'react'
// 导入 MUI styled 方法用于定义样式组件
import { styled } from '@mui/material/styles'
// 导入 MUI Box 组件
import { Box } from '@mui/material'

/**
 * 容器样式 - 主容器
 * 使用 flex 布局，纵向排列
 * gap: 子元素间距 8px
 * marginBottom: 下边距 4px
 */
const Container = styled(Box)({
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  width: '100%',
  marginBottom: '4px'
})

/**
 * 顶部标题行样式
 * display: flex - 水平布局
 * justifyContent: space-between - 左右分开排列
 * alignItems: center - 垂直居中
 */
const Header = styled(Box)({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '8px',
  minHeight: '24px'
})

/**
 * 标签样式
 * fontSize: 13px - 字体大小
 * fontWeight: 500 - 字体粗细
 * color: 根据主题自动调整
 */
const Label = styled('label')(({ theme }) => ({
  display: 'block',
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: '13px',
  fontWeight: 500,
  lineHeight: 1.4,
  color: theme.palette.text.secondary
}))

/**
 * 值输入框容器样式
 * display: flex - 水平布局
 * gap: 4px - 子元素间距
 * 包含：输入框、上下调整按钮
 */
const ValueBox = styled(Box)({
  display: 'flex',
  alignItems: 'stretch', // 让子元素高度拉伸对齐
  gap: '4px'
})

/**
 * 按钮容器样式 - 垂直排列上下按钮
 */
const ButtonGroup = styled(Box)({
  display: 'flex',
  flexDirection: 'column',
  gap: '2px'
})

/**
 * 数值输入框样式
 * width: 80px - 固定宽度（更长）
 * padding: 4px 12px - 内边距（更扁）
 * fontFamily: monospace - 等宽字体显示数字
 * textAlign: right - 右对齐
 * '&:focus' - 获得焦点时的样式
 */
const ValueInput = styled('input')(({ theme }) => {
  const isDark = theme.palette.mode === 'dark'
  return {
    width: '80px',
    padding: '4px 12px',
    fontSize: '14px',
    fontWeight: 500,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    textAlign: 'center',
    borderRadius: '3px',
    border: `1px solid ${isDark ? '#555' : '#e0e0e0'}`,
    backgroundColor: isDark ? '#2a2a2a' : '#f9f9f9',
    color: theme.palette.text.primary,
    outline: 'none',
    '&:focus': {
      borderColor: theme.palette.primary.main,
      backgroundColor: isDark ? '#333' : '#fff'
    },
    // 隐藏浏览器默认的数字输入框箭头
    '&::-webkit-inner-spin-button': {
      WebkitAppearance: 'none',
      margin: 0
    },
    '&::-webkit-outer-spin-button': {
      WebkitAppearance: 'none',
      margin: 0
    },
    MozAppearance: 'textfield'
  }
})

/**
 * 上下调整按钮样式
 * width: 24px, height: 自适应（垂直排列时各占一半）
 * padding: 0 - 无内边距
 * display: flex - 居中内容
 * transition: all 0.2s - 平滑动画
 * '&:hover' - 悬停效果
 * '&:active' - 按下效果
 */
const UpDownButton = styled('button')(({ theme }) => {
  const isDark = theme.palette.mode === 'dark'
  return {
    width: '24px',
    height: '50%',
    minHeight: '18px',
    padding: '0',
    border: `1px solid ${isDark ? '#555' : '#e0e0e0'}`,
    borderRadius: '3px',
    backgroundColor: isDark ? '#2a2a2a' : '#f9f9f9',
    cursor: 'pointer',
    fontSize: '10px',
    fontWeight: 600,
    color: theme.palette.text.secondary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.2s',
    '&:hover': {
      backgroundColor: isDark ? '#333' : '#f0f0f0',
      borderColor: isDark ? '#666' : '#ccc'
    },
    '&:active': {
      backgroundColor: isDark ? '#3a3a3a' : '#e8e8e8'
    }
  }
})

/**
 * 滑块容器样式
 * position: relative - 相对定位，作为子元素的参考
 * 容纳蓝色进度条、轨道背景、滑块在同一容器中
 */
const SliderContainer = styled(Box)({
  position: 'relative',
  width: '100%',
  height: '20px',
  display: 'flex',
  alignItems: 'center'
})

/**
 * 灰色轨道背景样式
 * position: absolute - 绝对定位
 * top: 50%, transform: translateY(-50%) - 垂直居中
 * height: 4px - 轨道高度
 * background: 灰色 - 轨道颜色
 * borderRadius: 2px - 圆润效果
 * pointerEvents: none - 不阻挡鼠标事件
 * zIndex: 0 - 最底层
 */
const TrackBackground = styled(Box)(({ theme }) => {
  const isDark = theme.palette.mode === 'dark'
  return {
    position: 'absolute',
    top: '50%',
    left: 0,
    right: 0,
    height: '4px',
    transform: 'translateY(-50%)',
    borderRadius: '2px',
    background: isDark ? '#404040' : '#e0e0e0',
    pointerEvents: 'none',
    zIndex: 0
  }
})

/**
 * 蓝色进度条样式（显示已填充部分）
 * position: absolute - 绝对定位
 * top: 50%, transform: translateY(-50%) - 垂直居中
 * height: 4px - 进度条高度
 * background: 根据主题使用主色调渐变
 * borderRadius: 2px - 圆润效果
 * pointerEvents: none - 不阻挡鼠标事件
 * zIndex: 1 - 在轨道上方
 * width 由 sx prop 动态控制（根据当前值计算百分比）
 */
const SliderBackground = styled(Box)(({ theme }) => ({
  position: 'absolute',
  top: '50%',
  left: 0,
  height: '4px',
  transform: 'translateY(-50%)',
  borderRadius: '2px',
  background: `linear-gradient(90deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.dark} 100%)`,
  pointerEvents: 'none',
  zIndex: 1
}))

/**
 * 滑块输入框样式
 * 返回对象型样式以使用主题信息
 * position: absolute, zIndex: 2 - 最顶层显示
 * appearance: none - 移除浏览器默认样式
 * background: transparent - 透明背景
 *
 * '::-webkit-slider-runnable-track' - Chrome/Safari 轨道
 * '::-webkit-slider-thumb' - Chrome/Safari 滑块
 * '::-moz-range-thumb' - Firefox 滑块
 * '::-moz-range-track' - Firefox 轨道
 */
const StyledSlider = styled('input')(({ theme }) => {
  const isDark = theme.palette.mode === 'dark'
  return {
    position: 'absolute',
    top: '50%',
    left: 0,
    transform: 'translateY(-50%)',
    zIndex: 2,
    width: '100%',
    height: '8px',
    borderRadius: '2px',
    cursor: 'pointer',
    appearance: 'none',
    WebkitAppearance: 'none',
    background: 'transparent',
    outline: 'none',
    border: 'none',
    padding: 0,
    margin: 0,
    // 轨道样式（透明）
    '&::-webkit-slider-runnable-track': {
      background: 'transparent',
      height: '4px',
      borderRadius: '2px',
      border: 'none'
    },
    // 滑块样式（根据主题调整）
    '&::-webkit-slider-thumb': {
      appearance: 'none',
      WebkitAppearance: 'none',
      width: '18px',
      height: '18px',
      borderRadius: '50%',
      background: isDark ? '#424242' : '#fff',
      cursor: 'pointer',
      boxShadow: isDark ? '0 2px 8px rgba(0, 0, 0, 0.6)' : '0 2px 8px rgba(0, 0, 0, 0.3)',
      border: `2px solid ${theme.palette.primary.main}`,
      marginTop: '-7px'
    },
    // Firefox 滑块样式
    '&::-moz-range-thumb': {
      width: '18px',
      height: '18px',
      borderRadius: '50%',
      background: isDark ? '#424242' : '#fff',
      cursor: 'pointer',
      border: `2px solid ${theme.palette.primary.main}`,
      boxShadow: isDark ? '0 2px 8px rgba(0, 0, 0, 0.6)' : '0 2px 8px rgba(0, 0, 0, 0.3)'
    },
    // Firefox 轨道样式
    '&::-moz-range-track': {
      background: 'transparent',
      border: 'none'
    }
  }
})

/**
 * 组件接口定义
 * @param value - 当前值（必需）
 * @param onChange - 值变化回调函数（必需）
 * @param label - 显示标签，默认为 'LoRA'
 * @param min - 最小值，默认为 0
 * @param max - 最大值，默认为 1.2
 * @param step - 步长，默认为 0.01
 * @param defaultValue - 默认值，默认为 1
 */
interface InputSliderProps {
  value: number
  onChange: (value: number) => void
  label?: string
  min?: number
  max?: number
  step?: number
  defaultValue?: number
}

// 定义上下调整按钮的步长（每次点击增减 0.01）
const ADJUST_STEP = 0.01

/**
 * InputSlider 组件 - 结合输入框、按钮和滑块的复合控件
 * 提供三种输入方式：直接输入数字、上下按钮调整、拖动滑块
 *
 * @component
 * @example
 * <InputSlider
 *   value={loraValue}
 *   onChange={setLoraValue}
 *   label="LoRA强度"
 *   min={0}
 *   max={1.2}
 *   step={0.01}
 * />
 */
export default function InputSlider({
  value,
  onChange,
  label = 'LoRA',
  min = 0,
  max = 1.2,
  step = 0.01,
  defaultValue = 1
}: InputSliderProps) {
  // 输入框显示的值（可能是字符串，用于编辑状态）
  const [inputValue, setInputValue] = useState<number | string>(value)

  /**
   * 同步外部 value 变化到内部 inputValue
   * 当父组件更新 value 时，同步更新输入框显示值
   */
  useEffect(() => {
    setInputValue(value)
  }, [value])

  /**
   * 滑块变化处理
   * 用户拖动滑块时触发
   * @param e - 事件对象
   */
  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      // 转换字符串为浮点数并触发 onChange 回调
      onChange(parseFloat(e.target.value))
    },
    [onChange]
  )

  /**
   * 输入框值变化处理
   * 用户在输入框中输入时触发，不验证范围
   * @param e - 事件对象
   */
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // 保留空字符串以支持清空编辑
    setInputValue(e.target.value === '' ? '' : parseFloat(e.target.value))
  }, [])

  /**
   * 输入框失焦处理
   * 验证输入值并将其限制在合法范围内
   * 1. 检查是否为有效数字
   * 2. 如果无效则使用默认值
   * 3. 限制在 [min, max] 范围内
   * 4. 按 step 进行舍入
   * 5. 四舍五入到 4 位小数
   */
  const handleInputBlur = useCallback(() => {
    // 将输入值转换为数字（如果是字符串）
    let newValue = typeof inputValue === 'string' ? parseFloat(inputValue) : inputValue

    // 如果是无效数字或空字符串，使用默认值
    if (isNaN(newValue) || inputValue === '') {
      newValue = defaultValue
    }

    // 限制在 [min, max] 范围内
    newValue = Math.max(min, Math.min(max, newValue))

    // 按 step 进行舍入
    newValue = Math.round(newValue / step) * step

    // 四舍五入到 4 位小数（避免浮点数精度问题）
    newValue = parseFloat(newValue.toFixed(4))

    // 通知父组件新的值
    onChange(newValue)
    // 更新输入框显示值
    setInputValue(newValue)
  }, [inputValue, defaultValue, min, max, step, onChange])

  /**
   * 夹紧函数 - 将数值限制在 [min, max] 范围内
   * @param val - 要限制的值
   * @returns 被限制后的值
   */
  const clamp = useCallback(
    (val: number) => {
      // 取最大值和最小值之间的中间值
      const clamped = Math.max(min, Math.min(max, val))
      // 限制到 4 位小数精度
      return parseFloat(clamped.toFixed(4))
    },
    [min, max]
  )

  /**
   * 调整值处理
   * 用于上下按钮点击事件
   * @param delta - 增加或减少的量
   */
  const handleAdjust = useCallback(
    (delta: number) => {
      // 调整值后并夹紧到范围内
      onChange(clamp(value + delta))
    },
    [value, onChange, clamp]
  )

  /**
   * 渲染组件
   * 结构：
   * - 顶行：标签 + 输入框 + 上下按钮
   * - 底行：滑块
   */
  return (
    <Container>
      {/* 顶部控制区 */}
      <Header>
        {/* 左侧标签 */}
        <Label>{label}</Label>

        {/* 右侧控制组 */}
        <ValueBox>
          {/* 数值输入框 */}
          <ValueInput
            type="number"
            value={inputValue}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            // 支持 Enter 键确认
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleInputBlur()
              }
            }}
            min={min}
            max={max}
            step={step}
          />

          {/* 上下按钮组 - 垂直排列 */}
          <ButtonGroup>
            {/* 上调按钮 */}
            <UpDownButton onClick={() => handleAdjust(ADJUST_STEP)} title="增加">
              ▲
            </UpDownButton>

            {/* 下调按钮 */}
            <UpDownButton onClick={() => handleAdjust(-ADJUST_STEP)} title="减小">
              ▼
            </UpDownButton>
          </ButtonGroup>
        </ValueBox>
      </Header>

      {/* 滑块区 - 容纳轨道、进度条、滑块三层 */}
      <SliderContainer>
        {/* 灰色轨道背景 - 最底层 */}
        <TrackBackground />

        {/* 蓝色进度条 - 中层 */}
        <SliderBackground
          sx={{
            // 根据当前值计算进度条宽度百分比
            width: `${((value - min) / (max - min)) * 100}%`
          }}
        />

        {/* 滑块输入框 - 最顶层 */}
        <StyledSlider
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={handleSliderChange}
        />
      </SliderContainer>
    </Container>
  )
}
