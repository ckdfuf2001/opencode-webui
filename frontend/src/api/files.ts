import { useQuery } from '@tanstack/react-query'
import { API_BASE_URL } from '@/config'
import type { FileInfo, ChunkedFileInfo, PatchOperation } from '@/types/files'

export class FileApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'FileApiError'
    this.status = status
  }
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof FileApiError && error.status === 404
}

function shouldRetryFileQuery(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: number })?.status
  if (typeof status === 'number' && status >= 400 && status < 500) return false
  return failureCount < 2
}

async function fetchFile(path: string): Promise<FileInfo> {
  const response = await fetch(`${API_BASE_URL}/api/files/${path}`)

  if (!response.ok) {
    throw new FileApiError(`Failed to load file: ${response.statusText || response.status}`, response.status)
  }

  return response.json()
}

export function useFile(path: string | undefined) {
  return useQuery<FileInfo, Error>({
    queryKey: ['file', path],
    queryFn: () => path ? fetchFile(path) : Promise.reject(new FileApiError('No file path provided', 400)),
    enabled: !!path,
    retry: shouldRetryFileQuery,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    // 파일 본문까지 통째로 들고 있어 inactive 캐시가 쌓이면 크다.
    // staleTime 0이라 마운트 시 어차피 재조회하므로 1분만 유지해도 동작 동일.
    gcTime: 60 * 1000,
  })
}

export interface FileStat {
  exists: boolean
  isDirectory: boolean
  name: string
  size: number
  lastModified?: string
}

export async function getFileStat(filePath: string): Promise<FileStat> {
  const response = await fetch(`${API_BASE_URL}/api/files/stat?path=${encodeURIComponent(filePath)}`)

  if (!response.ok) {
    throw new Error(`Failed to stat file: ${response.statusText}`)
  }

  return response.json()
}

export async function fetchFileRange(path: string, startLine: number, endLine: number): Promise<ChunkedFileInfo> {
  const response = await fetch(`${API_BASE_URL}/api/files/${path}?startLine=${startLine}&endLine=${endLine}`)
  
  if (!response.ok) {
    throw new Error(`Failed to load file range: ${response.statusText}`)
  }
  
  return response.json()
}

export interface UploadProgress {
  loaded: number
  total: number
}

// 같은 파일 중복 업로드 방지용 (붙여넣기 연타 대응)
const inFlightUploads = new Set<string>()
const inFlightXhrs = new Map<string, XMLHttpRequest>()

export function uploadFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

export function isUploadInFlight(file: File): boolean {
  return inFlightUploads.has(uploadFileKey(file))
}

export function abortUpload(file: File): boolean {
  const key = uploadFileKey(file)
  const xhr = inFlightXhrs.get(key)
  if (xhr) {
    try { xhr.abort() } catch {}
    return true
  }
  return false
}

export function abortAllUploads(): void {
  for (const xhr of inFlightXhrs.values()) {
    try { xhr.abort() } catch {}
  }
}

export class DuplicateUploadError extends Error {
  constructor(fileName: string) {
    super(`"${fileName}" 이미 업로드 중입니다`)
    this.name = 'DuplicateUploadError'
  }
}

// fetch에는 업로드 진행률이 없어 XHR로 전송한다
export function uploadFileWithProgress(
  url: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<any> {
  const key = uploadFileKey(file)
  if (inFlightUploads.has(key)) return Promise.reject(new DuplicateUploadError(file.name))
  inFlightUploads.add(key)
  return new Promise((resolve, reject) => {
    const done = () => {
      inFlightUploads.delete(key)
      inFlightXhrs.delete(key)
    }
    const xhr = new XMLHttpRequest()
    inFlightXhrs.set(key, xhr)
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total)
    }
    xhr.onload = () => {
      done()
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          resolve(null)
        }
      } else {
        try {
          const body = JSON.parse(xhr.responseText)
          reject(new Error(body?.error || `Upload failed: ${xhr.statusText}`))
        } catch {
          reject(new Error(`Upload failed: ${xhr.statusText}`))
        }
      }
    }
    xhr.onerror = () => {
      done()
      reject(new Error('Upload failed'))
    }
    xhr.onabort = () => {
      done()
      reject(new Error('Upload cancelled'))
    }
    const formData = new FormData()
    formData.append('file', file)
    xhr.send(formData)
  })
}

export async function applyFilePatches(path: string, patches: PatchOperation[]): Promise<{ success: boolean; totalLines: number }> {
  const response = await fetch(`${API_BASE_URL}/api/files/${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patches }),
  })
  
  if (!response.ok) {
    throw new Error(`Failed to apply patches: ${response.statusText}`)
  }
  
  return response.json()
}