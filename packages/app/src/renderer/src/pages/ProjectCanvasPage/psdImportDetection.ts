export const PSD_IMPORT_EXTENSIONS = ['.psd', '.psb']
export const PSD_IMPORT_ACCEPT = PSD_IMPORT_EXTENSIONS.join(',')

export function isPsdImportFile(file: Pick<File, 'name' | 'type'>): boolean {
  const normalizedName = file.name.trim().toLowerCase()
  return PSD_IMPORT_EXTENSIONS.some((extension) => normalizedName.endsWith(extension))
}
