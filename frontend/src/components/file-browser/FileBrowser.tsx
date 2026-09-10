import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { FileTree } from './FileTree'
import { FileOperations } from './FileOperations'
import { FilePreview } from './FilePreview'
import { MobileFilePreviewModal } from './MobileFilePreviewModal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { FolderOpen, Upload, RefreshCw, ArrowUpDown, Check } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { FileInfo } from '@/types/files'
import { API_BASE_URL } from '@/config'
import { useMobile } from '@/hooks/useMobile'
import { useFile, uploadFileWithProgress, isUploadInFlight, DuplicateUploadError, FileApiError } from '@/api/files'
import { listHtmlPages } from '@/api/html-pages'
import { normalizeTreePath } from '@/lib/tree-path'
import { downloadSingleFile, downloadFolderAsZip } from '@/lib/fileDownload'
import { showToast } from '@/lib/toast'

const normalizePath = (p: string): string => p.replace(/\\/g, '/').split('/').filter(Boolean).join('/')

const clampToBasePath = (path: string, base: string): string => {
  const current = normalizePath(path)
  const basePath = normalizePath(base)
  if (!basePath || basePath === '.') return current
  if (current === basePath || current.startsWith(basePath + '/')) return current
  return basePath
}

interface DroppedItem {
  file: File
  relativePath: string
}

function dropItemEntry(item: DataTransferItem): FileSystemEntry | null {
  const getAsEntry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry
  if (typeof getAsEntry !== 'function') return null
  try {
    return getAsEntry.call(item)
  } catch {
    return null
  }
}

function readDirEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const pump = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        pump()
      }, reject)
    }
    pump()
  })
}

// 폴더 드롭을 지원한다. 디렉터리를 File 로 바로 업로드하면
// 브라우저가 읽기를 거부해 net::ERR_ACCESS_DENIED 가 난다.
// FileSystemEntry 순회로 파일만 골라 상대경로와 함께 수집한다.
async function collectDropItems(dataTransfer: DataTransfer): Promise<{ files: DroppedItem[]; dirs: string[] }> {
  const files: DroppedItem[] = []
  const dirs: string[] = []
  const items = Array.from(dataTransfer.items ?? [])
  const walk = async (entry: FileSystemEntry, rel: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      )
      files.push({ file, relativePath: rel })
    } else if (entry.isDirectory) {
      if (rel) dirs.push(rel)
      const children = await readDirEntries((entry as FileSystemDirectoryEntry).createReader())
      for (const child of children) {
        await walk(child, rel ? `${rel}/${child.name}` : child.name)
      }
    }
  }
  for (const item of items) {
    if (item.kind !== 'file') continue
    const entry = dropItemEntry(item)
    if (!entry) continue
    try {
      await walk(entry, entry.name)
    } catch {
      // 읽을 수 없는 항목은 건너뛴다
    }
  }
  return { files, dirs }
}




interface FileBrowserProps {
  basePath?: string
  onFileSelect?: (file: FileInfo) => void
  embedded?: boolean
  initialSelectedFile?: string
  onDirectoryLoad?: (info: { workspaceRoot?: string; currentPath: string }) => void
}

type FileSort = 'name-asc' | 'name-desc' | 'mtime-asc' | 'mtime-desc'

function FileSortSelect({ value, onChange }: { value: FileSort; onChange: (v: FileSort) => void }) {
  const items: { value: FileSort; label: string }[] = [
    { value: 'name-asc', label: 'Name ascending' },
    { value: 'name-desc', label: 'Name descending' },
    { value: 'mtime-desc', label: 'Date newest' },
    { value: 'mtime-asc', label: 'Date oldest' },
  ]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" title="Sort">
          <ArrowUpDown className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem key={item.value} onClick={() => onChange(item.value)}>
            <Check className={`w-4 h-4 mr-2 ${value === item.value ? 'opacity-100' : 'opacity-0'}`} />
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function FileBrowser({ basePath = '', onFileSelect, embedded = false, initialSelectedFile, onDirectoryLoad }: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState(basePath)
  const queryClient = useQueryClient()
  const { data: files, isLoading: queryLoading, error: filesQueryError } = useQuery<FileInfo, Error>({
    queryKey: ['files', currentPath],
    queryFn: async () => {
      if (!currentPath && currentPath !== '') return null
      const path = currentPath || basePath || '.'
      const response = await fetch(`${API_BASE_URL}/api/files/${path}`)
      if (!response.ok) throw new FileApiError('Failed to load files', response.status)
      return response.json()
    },
    enabled: true,
    staleTime: 60 * 1000,
    retry: (failureCount, error) => {
      const status = (error as { status?: number })?.status
      if (typeof status === 'number' && status >= 400 && status < 500) return false
      return failureCount < 2
    },
  })

  useEffect(() => {
    if (filesQueryError) {
      setError(filesQueryError instanceof Error ? filesQueryError.message : 'Failed to load files')
    } else if (files) {
      setError(null)
    }
  }, [filesQueryError, files])

  const setFiles = useCallback((path: string, data: FileInfo | null) => {
    queryClient.setQueryData(['files', path], data)
  }, [queryClient])
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<FileSort>('name-asc')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<{ name: string; loaded: number; total: number; index: number; count: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false)
  
  const dropZoneRef = useRef<HTMLDivElement>(null)
  const isMobile = useMobile()

  const { data: managedPages = [] } = useQuery({
    queryKey: ['html-pages'],
    queryFn: listHtmlPages,
    staleTime: 60 * 1000,
  })
  const browserOpenPaths = useMemo(() => new Set(
    managedPages.filter((p) => p.kind === 'file' && p.path).map((p) => normalizeTreePath(p.path)),
  ), [managedPages])

  // 채팅에서 파일을 열면 해당 파일의 디렉터리로 트리를 이동시킨다.
  useEffect(() => {
    if (!initialSelectedFile || !initialSelectedFile.includes('/')) return
    const dir = normalizePath(initialSelectedFile).split('/').slice(0, -1).join('/')
    const clamped = clampToBasePath(dir, basePath)
    setCurrentPath((prev) => (prev === clamped ? prev : clamped))
  }, [initialSelectedFile, basePath])

   const { data: initialFileData, error: initialFileError } = useFile(initialSelectedFile)
  const initialErrorToastedRef = useRef<string | null>(null)

useEffect(() => {
  if (initialFileData) {
    setSelectedFile(initialFileData)
    if (isMobile) {
      setIsPreviewModalOpen(true)
    }
  }
}, [initialFileData, isMobile])

useEffect(() => {
  if (initialFileError && initialSelectedFile && initialErrorToastedRef.current !== initialSelectedFile) {
    initialErrorToastedRef.current = initialSelectedFile
    showToast.error(initialFileError.message, { duration: 5000 })
    setSelectedFile(null)
  }
}, [initialFileError, initialSelectedFile])

  const loadFiles = async (path: string) => {
    setLoading(true)
    setError(null)
    const resolvedPath = clampToBasePath(path, basePath)
    
    try {
      const response = await fetch(`${API_BASE_URL}/api/files/${resolvedPath}`)
      if (!response.ok) {
        throw new Error(`Failed to load files: ${response.statusText}`)
      }
      
      const data = await response.json()
      setFiles(resolvedPath, data)
      setCurrentPath(resolvedPath)
      onDirectoryLoad?.({ workspaceRoot: data.workspaceRoot, currentPath: resolvedPath })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load files')
    } finally {
      setLoading(false)
    }
  }

  const handleFileSelect = useCallback(async (file: FileInfo) => {
    if (file.isDirectory) {
      setSelectedFile(null)
      return
    }
    
    // Fetch the full file content when selecting a file
    setLoading(true)
    try {
      const response = await fetch(`${API_BASE_URL}/api/files/${file.path}`)
      if (!response.ok) {
        throw new Error(`Failed to load file: ${response.statusText}`)
      }
      
      const fullFileData = await response.json()
      setSelectedFile(fullFileData)
      onFileSelect?.(fullFileData)
      
      // On mobile, open preview in modal
      if (isMobile) {
        setIsPreviewModalOpen(true)
      }
    } catch (err) {
      showToast.error(err instanceof Error ? err.message : 'Failed to load file', { duration: 5000 })
      setSelectedFile(null)
    } finally {
      setLoading(false)
    }
  }, [onFileSelect, isMobile])

  const handleCloseModal = useCallback(() => {
    setIsPreviewModalOpen(false)
    setSelectedFile(null)
  }, [])

  const handleDirectoryClick = (path: string) => {
    loadFiles(path)
  }

  const handleRefresh = () => {
    loadFiles(currentPath)
  }

  const ensureDropDirs = useCallback(async (dirs: string[]) => {
    const unique = [...new Set(dirs.map((d) => normalizePath(d)).filter(Boolean))]
    for (const dir of unique) {
      const target = normalizePath(`${currentPath}/${dir}`)
      const response = await fetch(`${API_BASE_URL}/api/files/${target}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'folder' }),
      })
      if (!response.ok) {
        throw new Error(`Create folder failed: ${dir}`)
      }
    }
  }, [currentPath])

  const handleUploadItems = useCallback(async (items: DroppedItem[], dirs: string[]) => {
    const freshItems = items.filter(({ file }) => !isUploadInFlight(file))
    if (freshItems.length === 0 && dirs.length === 0) return
    if (freshItems.length < items.length) {
      showToast.info(`이미 업로드 중인 ${items.length - freshItems.length}개 파일은 제외합니다`)
    }
    setLoading(true)
    setError(null)
    let successCount = 0
    let failCount = 0
    let lastError: string | null = null
    try {
      const parentDirs = freshItems.map(({ relativePath }) => {
        const parts = normalizePath(relativePath).split('/')
        parts.pop()
        return parts.join('/')
      })
      await ensureDropDirs([...dirs, ...parentDirs])
      setUploadProgress({ name: freshItems[0]?.file.name ?? '', loaded: 0, total: freshItems[0]?.file.size || 1, index: 1, count: freshItems.length })
      let lastProgAt = 0
      for (let i = 0; i < freshItems.length; i++) {
        const { file, relativePath } = freshItems[i]
        const parts = normalizePath(relativePath).split('/')
        parts.pop()
        const dir = parts.join('/')
        const target = dir ? normalizePath(`${currentPath}/${dir}`) : currentPath
        setUploadProgress({ name: relativePath, loaded: 0, total: file.size || 1, index: i + 1, count: freshItems.length })
        try {
          await uploadFileWithProgress(`${API_BASE_URL}/api/files/${target}`, file, (loaded, total) => {
            const now = Date.now()
            if (now - lastProgAt < 150) return
            lastProgAt = now
            setUploadProgress({ name: relativePath, loaded, total: total || file.size || 1, index: i + 1, count: freshItems.length })
          })
          successCount++
        } catch (err) {
          if (err instanceof DuplicateUploadError) continue
          failCount++
          lastError = err instanceof Error ? err.message : 'Upload failed'
        }
      }
    } catch (err) {
      failCount++
      lastError = err instanceof Error ? err.message : 'Upload failed'
    } finally {
      setLoading(false)
      setUploadProgress(null)
    }
    if (successCount > 0 || dirs.length > 0) {
      showToast.success(`Uploaded ${successCount} file(s) to ${currentPath || '/'}`, {
        description: failCount > 0 ? `${failCount} failed` : undefined,
        duration: 5000,
      })
      await loadFiles(currentPath)
    }
    if (failCount > 0 && successCount === 0) {
      const message = lastError || 'Upload failed'
      showToast.error(message.startsWith('Upload failed') ? message : `Upload failed: ${message}`)
      setError(message)
    } else if (failCount > 0) {
      showToast.error(`${failCount} file(s) failed to upload`)
    }
  }, [currentPath, ensureDropDirs])

  const handleUpload = useCallback(async (files: FileList) => {
    const fileArray = Array.from(files)
    if (fileArray.length === 0) return
    const freshFiles = fileArray.filter((f) => !isUploadInFlight(f))
    if (freshFiles.length < fileArray.length) {
      showToast.info(`이미 업로드 중인 ${fileArray.length - freshFiles.length}개 파일은 제외합니다`)
    }
    if (freshFiles.length === 0) return
    let successCount = 0
    let failCount = 0
    let lastResult: { name?: string; path?: string } | null = null
    let lastError: string | null = null
    // 영역을 즉시 띄우고 (첫 paint 확보), 진행 콜백은 스로틀로 렌더 폭풍 방지
    setUploadProgress({ name: freshFiles[0].name, loaded: 0, total: freshFiles[0].size || 1, index: 1, count: freshFiles.length })
    let lastProgAt = 0
    for (let i = 0; i < freshFiles.length; i++) {
      const file = freshFiles[i]
      setUploadProgress({ name: file.name, loaded: 0, total: file.size || 1, index: i + 1, count: freshFiles.length })
      try {
        lastResult = await uploadFileWithProgress(`${API_BASE_URL}/api/files/${currentPath}`, file, (loaded, total) => {
          const now = Date.now()
          if (now - lastProgAt < 150) return
          lastProgAt = now
          setUploadProgress({ name: file.name, loaded, total: total || file.size || 1, index: i + 1, count: freshFiles.length })
        })
        successCount++
      } catch (err) {
        if (err instanceof DuplicateUploadError) continue
        failCount++
        lastError = err instanceof Error ? err.message : 'Upload failed'
      }
    }
    setUploadProgress(null)
    if (successCount > 0) {
      if (freshFiles.length === 1) {
        showToast.success(`Uploaded "${lastResult?.name || freshFiles[0].name}" to ${currentPath || '/'}`, {
          description: lastResult?.path ? lastResult.path : undefined,
          duration: 5000,
        })
      } else {
        showToast.success(`Uploaded ${successCount} file(s) to ${currentPath || '/'}`, {
          description: failCount > 0 ? `${failCount} failed` : undefined,
          duration: 5000,
        })
      }
      await loadFiles(currentPath)
    }
    if (failCount > 0 && successCount === 0) {
      const message = lastError || 'Upload failed'
      showToast.error(message.startsWith('Upload failed') ? message : `Upload failed: ${message}`)
      setError(message)
    } else if (failCount > 0) {
      showToast.error(`${failCount} file(s) failed to upload`)
    }
  }, [currentPath])

  const handleCreateFile = useCallback(async (name: string, type: 'file' | 'folder') => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/files/${currentPath}/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, content: type === 'file' ? '' : undefined }),
      })
      
      if (!response.ok) {
        throw new Error(`Create failed: ${response.statusText}`)
      }
      
      await loadFiles(currentPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed')
    }
  }, [currentPath])

  const handleDelete = useCallback(async (path: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/files/${path}`, {
        method: 'DELETE',
      })
      
      if (!response.ok) {
        throw new Error(`Delete failed: ${response.statusText}`)
      }
      
      await loadFiles(currentPath)
      setSelectedFile(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }, [currentPath])

  const handleRename = useCallback(async (oldPath: string, newPath: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/files/${oldPath}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPath }),
      })
      
      if (!response.ok) {
        throw new Error(`Rename failed: ${response.statusText}`)
      }
      
      await loadFiles(currentPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed')
    }
  }, [currentPath])

  const handleDownload = useCallback(async (file: FileInfo) => {
    try {
      if (file.isDirectory) {
        showToast.info(`Preparing ZIP for ${file.name}…`)
        const { files: n } = await downloadFolderAsZip(file.path, file.name)
        showToast.success(`Downloaded ${file.name}.zip (${n} file(s))`)
      } else {
        await downloadSingleFile(file.path, file.name)
        showToast.success(`Downloaded ${file.name}`)
      }
    } catch (err) {
      showToast.error(err instanceof Error ? err.message : 'Download failed')
    }
  }, [])

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!dropZoneRef.current) return
    const next = e.relatedTarget as Node | null
    if (next && dropZoneRef.current.contains(next)) {
      return
    }
    setIsDragging(false)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const { files, dirs } = await collectDropItems(e.dataTransfer)
    if (files.length > 0 || dirs.length > 0) {
      await handleUploadItems(files, dirs)
    } else if (e.dataTransfer.files.length > 0) {
      await handleUpload(e.dataTransfer.files)
    } else {
      showToast.info('드롭한 항목에서 업로드할 파일을 찾지 못했습니다')
    }
  }

  useEffect(() => {
    loadFiles(basePath)
  }, [basePath])

  useEffect(() => {
    const handleFileSaved = (event: CustomEvent<{ path: string; content: string }>) => {
      if (selectedFile && selectedFile.path === event.detail.path) {
        handleFileSelect(selectedFile)
      }
    }

    window.addEventListener('fileSaved', handleFileSaved as EventListener)
    return () => window.removeEventListener('fileSaved', handleFileSaved as EventListener)
  }, [selectedFile, handleFileSelect])

  // Handle escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isPreviewModalOpen) {
        handleCloseModal()
      }
    }

    if (isPreviewModalOpen) {
      document.addEventListener('keydown', handleEscape)
      return () => document.removeEventListener('keydown', handleEscape)
    }
  }, [isPreviewModalOpen])

  const filteredFiles = useMemo(() => {
    const q = searchQuery.toLowerCase()
    const list = (files?.children ?? []).filter((file: FileInfo) => file.name.toLowerCase().includes(q))
    const mtimeOf = (f: FileInfo): number => {
      const t = new Date(f.lastModified ?? 0).getTime()
      return Number.isNaN(t) ? 0 : t
    }
    const byName = (a: FileInfo, b: FileInfo) =>
      a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' })
    list.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      switch (sortBy) {
        case 'name-desc': return byName(b, a)
        case 'mtime-asc': return mtimeOf(a) - mtimeOf(b) || byName(a, b)
        case 'mtime-desc': return mtimeOf(b) - mtimeOf(a) || byName(a, b)
        default: return byName(a, b)
      }
    })
    return list
  }, [files, searchQuery, sortBy])

  if (embedded) {
    return (
      <div 
        className="h-full flex flex-col bg-background relative"
        ref={dropZoneRef}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="absolute inset-0 z-50 bg-primary/10 border-2 border-dashed border-primary rounded-lg flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <Upload className="w-12 h-12 mx-auto mb-2 text-primary" />
              <p className="text-lg font-semibold text-primary">Drop files here to upload</p>
            </div>
          </div>
        )}
        
        {/* Mobile: Full width file listing, Desktop: Split view */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          <div className={`${isMobile ? 'w-full' : 'w-[30%] min-w-[160px]'} border-r border-border px-4 flex flex-col min-h-0`}>
            <div className="sticky top-0 z-20 bg-background flex flex-col gap-2 py-3 flex-shrink-0 pointer-events-auto">
              <div className="flex items-center justify-between pointer-events-auto">
                <Button variant="outline" size="sm" onClick={handleRefresh} className="pointer-events-auto">
                  <RefreshCw className="w-4 h-4" />
                </Button>
                <FileOperations
                  onUpload={handleUpload}
                  onCreate={handleCreateFile}
                  
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  placeholder="Search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-1 min-w-0"
                />
                <FileSortSelect value={sortBy} onChange={setSortBy} />
              </div>
            </div>
            
            {uploadProgress && (
              <div className="px-1 py-2 text-xs text-blue-600 dark:text-blue-400 flex-shrink-0">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="truncate">업로드 중 {uploadProgress.index}/{uploadProgress.count} — {uploadProgress.name}</span>
                  <span className="font-mono shrink-0">{Math.round((uploadProgress.loaded / Math.max(uploadProgress.total, 1)) * 100)}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-blue-500/20 overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-[width]"
                    style={{ width: `${Math.min(100, Math.round((uploadProgress.loaded / Math.max(uploadProgress.total, 1)) * 100))}%` }}
                  />
                </div>
              </div>
            )}
            {error && (
              <div className="text-sm text-destructive bg-destructive/10 p-2 rounded mb-4 flex-shrink-0">
                {error}
              </div>
            )}
            
            <div className="flex-1 overflow-y-auto overflow-x-scroll min-h-0">
              {(loading || queryLoading) ? (
                <div className="flex items-center justify-center h-64">
                  <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <FileTree
                  files={filteredFiles || []}
                  onFileSelect={handleFileSelect}
                  onDirectoryClick={handleDirectoryClick}
                  selectedFile={selectedFile}
                  onDelete={handleDelete}
                  onRename={handleRename}
                  onDownload={handleDownload}
                  currentPath={currentPath}
                  basePath={basePath}
                  isLoading={loading || queryLoading}
                  browserOpenPaths={browserOpenPaths}
                />
              )}
            </div>
          </div>
          
          {/* Desktop only: Preview panel */}
          {!isMobile && (
            <div className="flex-1 overflow-y-auto min-h-0 h-full">
              {selectedFile && !selectedFile.isDirectory ? (
                <FilePreview file={selectedFile} />
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  Select a file to preview
                </div>
              )}
            </div>
          )}
        </div>

 {/* Mobile: File Preview Modal */}
        <MobileFilePreviewModal 
          isOpen={isMobile && isPreviewModalOpen}
          onClose={handleCloseModal}
          file={selectedFile}
          showFilePreviewHeader={true}
        />
      </div>
    )
  }

  return (
    <div 
      className="h-full flex flex-col"
      ref={dropZoneRef}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <Card className="flex-1 relative">
        {isDragging && (
          <div className="absolute inset-0 z-50 bg-blue-50/90 border-2 border-dashed border-blue-500 rounded-lg flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <Upload className="w-12 h-12 mx-auto mb-2 text-blue-500" />
              <p className="text-lg font-semibold text-blue-600">Drop files here to upload</p>
            </div>
          </div>
        )}
        
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <FolderOpen className="w-5 h-5" />
              File Browser
            </CardTitle>
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
          
          {uploadProgress && (
            <div className="px-1 py-2 text-xs text-blue-600 dark:text-blue-400">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="truncate">업로드 중 {uploadProgress.index}/{uploadProgress.count} — {uploadProgress.name}</span>
                <span className="font-mono shrink-0">{Math.round((uploadProgress.loaded / Math.max(uploadProgress.total, 1)) * 100)}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-blue-500/20 overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-[width]"
                  style={{ width: `${Math.min(100, Math.round((uploadProgress.loaded / Math.max(uploadProgress.total, 1)) * 100))}%` }}
                />
              </div>
            </div>
          )}
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 p-2 rounded">
              {error}
            </div>
          )}
        </CardHeader>
        
        <CardContent className="flex-1 flex overflow-hidden min-h-0">
          {/* Mobile: Full width file listing, Desktop: Split view */}
          <div className={`${isMobile ? 'w-full' : 'w-1/3 min-w-[160px]'} border-r pr-4 flex flex-col min-h-0`}>
            <div className="flex flex-col gap-2 mb-4 flex-shrink-0">
              <div className="flex items-center justify-between">
                <Button variant="outline" size="sm" onClick={handleRefresh}>
                  <RefreshCw className="w-4 h-4" />
                </Button>
                <FileOperations
                  onUpload={handleUpload}
                  onCreate={handleCreateFile}
                  
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  placeholder="Search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-1 min-w-0"
                />
                <FileSortSelect value={sortBy} onChange={setSortBy} />
              </div>
            </div>
            
            {(loading || queryLoading) ? (
              <div className="flex items-center justify-center h-64">
                <RefreshCw className="w-6 h-6 animate-spin" />
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto overflow-x-scroll min-h-0">
                <FileTree
                  files={filteredFiles || []}
                  onFileSelect={handleFileSelect}
                  onDirectoryClick={handleDirectoryClick}
                  selectedFile={selectedFile}
                  onDelete={handleDelete}
                  onRename={handleRename}
                  onDownload={handleDownload}
                  currentPath={currentPath}
                  basePath={basePath}
                  isLoading={loading || queryLoading}
                  browserOpenPaths={browserOpenPaths}
                />
              </div>
            )}
          </div>
          
          {/* Desktop only: Preview panel */}
          {!isMobile && (
            <div className="flex-1 overflow-y-auto min-h-0 ">
              {selectedFile && !selectedFile.isDirectory ? (
                <FilePreview file={selectedFile} />
              ) : (
                <div className="flex items-center justify-center h-64 text-muted-foreground">
                  Select a file to preview
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

{/* Mobile: File Preview Modal */}
      <MobileFilePreviewModal 
        isOpen={isMobile && isPreviewModalOpen}
        onClose={handleCloseModal}
        file={selectedFile}
      />
    </div>
  )
}
