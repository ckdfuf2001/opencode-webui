export type DocKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'doc' | 'xls' | 'ppt' | 'msg' | 'visio'

export function detectDocKind(name: string): DocKind | null {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx' || ext === 'docm' || ext === 'dotm') return 'docx'
  if (ext === 'doc') return 'doc'
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm' || ext === 'xltx' || ext === 'xltm') return 'xlsx'
  if (ext === 'xlsb') return 'xls'
  if (ext === 'pptx' || ext === 'pptm' || ext === 'ppsx' || ext === 'potx') return 'pptx'
  if (ext === 'ppt') return 'ppt'
  if (ext === 'msg') return 'msg'
  if (ext === 'vsdx' || ext === 'vsd') return 'visio'
  return null
}
