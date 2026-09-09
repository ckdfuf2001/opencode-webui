import JSZip from 'jszip'
import { API_BASE_URL } from '@/config'
import type { FileInfo } from '@/types/files'

const encodePath = (p: string): string =>
  p.split('/').map((seg) => encodeURIComponent(seg)).join('/')

function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** 단일 파일 다운로드 (백엔드 ?download=true 스트림). */
export async function downloadSingleFile(path: string, name: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/files/${encodePath(path)}?download=true`)
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  saveBlob(name, await res.blob())
}

const MAX_ZIP_FILES = 1000
const MAX_ZIP_BYTES = 300 * 1024 * 1024

/** 폴더를 재귀 수집해 ZIP으로 내려받는다. 백엔드 변경 없이 기존 목록/원본 API만 사용. */
export async function downloadFolderAsZip(folderPath: string, folderName: string): Promise<{ files: number }> {
  const zip = new JSZip()
  const root = zip.folder(folderName) ?? zip
  let count = 0
  let bytes = 0
  const visited = new Set<string>()

  const walk = async (dirPath: string, dir: JSZip): Promise<void> => {
    if (visited.has(dirPath)) return
    visited.add(dirPath)
    const res = await fetch(`${API_BASE_URL}/api/files/${encodePath(dirPath)}`)
    if (!res.ok) throw new Error(`Failed to list ${dirPath} (${res.status})`)
    const info = (await res.json()) as FileInfo
    for (const child of info.children ?? []) {
      if (child.isDirectory) {
        await walk(child.path, dir.folder(child.name) ?? dir)
      } else {
        if (count >= MAX_ZIP_FILES) {
          throw new Error(`Too many files (>${MAX_ZIP_FILES}) — pick a smaller folder`)
        }
        const f = await fetch(`${API_BASE_URL}/api/files/${encodePath(child.path)}?raw=true`)
        if (!f.ok) throw new Error(`Failed to read ${child.name} (${f.status})`)
        const buf = await f.arrayBuffer()
        bytes += buf.byteLength
        if (bytes > MAX_ZIP_BYTES) throw new Error('Folder too large (>300MB)')
        dir.file(child.name, buf)
        count += 1
      }
    }
  }

  await walk(folderPath, root)
  if (count === 0) throw new Error('Folder is empty')
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
  saveBlob(`${folderName}.zip`, blob)
  return { files: count }
}
