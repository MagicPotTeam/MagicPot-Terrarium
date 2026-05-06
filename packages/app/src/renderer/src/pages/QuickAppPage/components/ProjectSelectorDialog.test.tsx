import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider } from '@mui/material'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { theme } from '@renderer/theme'
import { ProjectSelectorDialog } from './ProjectSelectorDialog'
import { QAppMenuItem } from '@shared/api/svcQApp'
import type { QAppCategory } from '@shared/qApp/category'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          'qapp.menu.config_project_app': 'Config Project Quick Apps',
          'qapp.menu.search_repo_app': 'Search repo quick apps...',
          'qapp.menu.no_qapp_available': 'No quick apps available'
        }) as Record<string, string>
      )[key] ?? key
  })
}))

const qAppItems: QAppMenuItem[] = [
  {
    key: 'illustriousXL',
    name: 'illustriousXL',
    isBuiltin: false,
    isDirectory: true,
    children: [
      {
        key: 'illustriousXL/text2img',
        name: 'text2img',
        isBuiltin: false,
        isDirectory: false
      }
    ]
  },
  {
    key: 'Qwen',
    name: 'Qwen',
    isBuiltin: false,
    isDirectory: true,
    children: [
      {
        key: 'Qwen/text2img',
        name: 'text2img',
        isBuiltin: false,
        isDirectory: false
      },
      {
        key: 'Qwen/colorize',
        name: 'colorize',
        isBuiltin: false,
        isDirectory: false
      },
      {
        key: 'Qwen/alpha',
        name: 'alpha',
        isBuiltin: false,
        isDirectory: false
      },
      {
        key: 'Qwen/video',
        name: 'video',
        category: 'video',
        isBuiltin: false,
        isDirectory: false
      }
    ]
  },
  {
    key: '~builtin/hunyuan3d',
    name: 'hunyuan3d',
    isBuiltin: true,
    isDirectory: true,
    children: [
      {
        key: '~builtin/hunyuan3d/concept',
        name: 'concept',
        isBuiltin: true,
        isDirectory: false
      }
    ]
  },
  {
    key: '~builtin/inspection/duplicate-check',
    name: 'duplicate-check',
    category: 'inspection',
    isBuiltin: true,
    isDirectory: false
  }
]

const renderDialog = (activeCategory: QAppCategory = 'image') => {
  const onClose = vi.fn()

  const Wrapper = () => {
    const [projectSelectedKeys, setProjectSelectedKeys] = useState<Set<string>>(new Set())

    return (
      <ThemeProvider theme={theme}>
        <ProjectSelectorDialog
          open
          onClose={onClose}
          activeTabId="tab-project-1"
          qAppItems={qAppItems}
          activeCategory={activeCategory}
          projectSelectedKeys={projectSelectedKeys}
          setProjectSelectedKeys={setProjectSelectedKeys}
          getDisplayName={(value) => value || ''}
        />
      </ThemeProvider>
    )
  }

  return render(<Wrapper />)
}

beforeEach(() => {
  localStorage.clear()
})

describe('ProjectSelectorDialog', () => {
  it('renders quick apps grouped by directory instead of a flat list', () => {
    renderDialog()

    expect(screen.getByText('illustriousXL')).toBeTruthy()
    expect(screen.getByText('Qwen')).toBeTruthy()
    expect(screen.getAllByText('text2img')).toHaveLength(2)
    expect(screen.getByText('Qwen / colorize')).toBeTruthy()
    expect(screen.queryByText('video')).toBeNull()
  })

  it('keeps matching children visible when searching by directory name', () => {
    renderDialog()

    fireEvent.change(screen.getByPlaceholderText('Search repo quick apps...'), {
      target: { value: 'Qwen' }
    })

    expect(screen.getByText('Qwen')).toBeTruthy()
    expect(screen.getByText('colorize')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.queryByText('illustriousXL')).toBeNull()
    expect(screen.getAllByText('text2img')).toHaveLength(1)
  })

  it('allows collapsing and re-expanding directory groups', async () => {
    renderDialog()

    fireEvent.click(screen.getByText('Qwen'))

    await waitFor(() => {
      expect(screen.queryByText('alpha')).toBeNull()
    })

    fireEvent.click(screen.getByText('Qwen'))

    await waitFor(() => {
      expect(screen.getByText('alpha')).toBeTruthy()
    })
  })

  it('selects all quick apps inside a directory when toggling the folder checkbox', () => {
    renderDialog()

    fireEvent.click(screen.getByLabelText('Select folder Qwen'))

    expect(localStorage.getItem('qapp.selected.tab-project-1')).toBe(
      '["Qwen/text2img","Qwen/colorize","Qwen/alpha"]'
    )
  })

  it('limits candidates to the active quick app category', () => {
    const { unmount } = renderDialog('image')

    expect(screen.getByText('Qwen')).toBeTruthy()
    expect(screen.queryByText('video')).toBeNull()
    expect(screen.queryByText('hunyuan3d')).toBeNull()
    expect(screen.queryByText('duplicate-check')).toBeNull()

    unmount()
    renderDialog('model3d')

    expect(screen.getByText('hunyuan3d')).toBeTruthy()
    expect(screen.getByText('concept')).toBeTruthy()
    expect(screen.queryByText('Qwen')).toBeNull()
  })

  it('keeps inspection quick apps only in the inspection category', () => {
    renderDialog('inspection')

    expect(screen.getByText('duplicate-check')).toBeTruthy()
    expect(screen.queryByText('Qwen')).toBeNull()
    expect(screen.queryByText('hunyuan3d')).toBeNull()
  })

  it('shows the folder checkbox as indeterminate when only part of a directory is selected', () => {
    renderDialog()

    fireEvent.click(screen.getByText('alpha'))

    expect(screen.getByLabelText('Select folder Qwen')).toHaveAttribute(
      'data-indeterminate',
      'true'
    )
  })

  it('persists project selections immediately when toggling a quick app', () => {
    renderDialog()

    fireEvent.click(screen.getByText('alpha'))

    expect(localStorage.getItem('qapp.selected.tab-project-1')).toBe('["Qwen/alpha"]')
  })
})
