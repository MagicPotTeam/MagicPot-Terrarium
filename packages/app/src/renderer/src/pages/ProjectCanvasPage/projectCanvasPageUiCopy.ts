export function isChineseUiLanguage(language?: string | null): boolean {
  return (language || '').toLowerCase().startsWith('zh')
}

export function getCanvasFilePreviewCopy(language?: string | null) {
  const isChinese = isChineseUiLanguage(language)

  return {
    titleFallback: isChinese ? '文件预览' : 'File Preview',
    editPlaceholder: isChinese ? '在这里编辑文件内容' : 'Edit file content here',
    embeddedImagesLabel: (count: number) =>
      isChinese ? `内嵌图片（${count}）` : `Embedded Images (${count})`,
    emptyTip: isChinese
      ? '文本文件可以在这里直接编辑。DOCX 和 PPTX 会在可用时显示提取出的正文和内嵌图片预览，XLSX 会显示工作表预览。旧版 DOC、XLS 和 PPT 会显示能够安全提取到的文本内容。'
      : 'Text files can be edited here. DOCX and PPTX files show extracted text plus embedded image previews when available, while XLSX files show worksheet previews. Legacy DOC, XLS, and PPT files show any readable text we can safely extract.',
    spreadsheetRowHeader: isChinese ? '行' : '#',
    spreadsheetSheetSummary: (rows: number, cols: number) =>
      isChinese ? `${rows} 行 × ${cols} 列` : `${rows} rows x ${cols} columns`,
    spreadsheetEmptySheetTip: isChinese
      ? '这个工作表暂时没有可提取的单元格内容，但你现在可以直接查看工作表结构。'
      : 'This worksheet does not contain extracted cell values yet, but you can still view the sheet structure here.',
    spreadsheetTruncatedHint: (
      visibleRows: number,
      visibleCols: number,
      totalRows: number,
      totalCols: number
    ) =>
      isChinese
        ? `当前展示前 ${visibleRows} 行、${visibleCols} 列，完整工作表约为 ${totalRows} 行 × ${totalCols} 列。`
        : `Showing the first ${visibleRows} rows and ${visibleCols} columns. The full sheet is about ${totalRows} rows x ${totalCols} columns.`,
    spreadsheetAddRowButton: isChinese ? '加行' : 'Add Row',
    spreadsheetDeleteRowButton: isChinese ? '删行' : 'Delete Row',
    spreadsheetAddColumnButton: isChinese ? '加列' : 'Add Column',
    spreadsheetDeleteColumnButton: isChinese ? '删列' : 'Delete Column',
    spreadsheetSelectedCellLabel: (cellLabel: string) =>
      isChinese ? `当前单元格：${cellLabel}` : `Selected cell: ${cellLabel}`,
    closeButton: isChinese ? '关闭' : 'Close',
    exportButton: isChinese ? '导出' : 'Export',
    saveButton: isChinese ? '保存' : 'Save'
  }
}

const BACKGROUND_COLOR_LABELS_ZH: Record<string, string> = {
  'Default Dark': '默认深色',
  'Dark Gray': '深灰',
  Graphite: '石墨灰',
  'Pure Black': '纯黑',
  Cream: '奶油白',
  'Light Gray': '浅灰',
  'Pure White': '纯白',
  'Dark Blue': '深蓝',
  'Dark Green': '深绿',
  Transparent: '透明'
}

export function getBackgroundColorLabel(label: string, language?: string | null): string {
  if (!isChineseUiLanguage(language)) return label
  return BACKGROUND_COLOR_LABELS_ZH[label] || label
}
