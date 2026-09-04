import { useState, useEffect, useRef, useCallback } from 'react'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { FileTree } from './FileTree'
import { FileOperations } from './FileOperations'
import { FilePreview } from './FilePreview'
import { MobileFilePreviewModal } from './MobileFilePreviewModal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { FolderOpen, Upload, RefreshCw } from 'lucide-react'
import type { FileInfo } from '@/types/files'
import { API_BASE_URL } from '@/config'
import { useMobile } from '@/hooks/useMobile'
import { useFile } from '@/api/files'
import { showToast } from '@/lib/toast'

const normalizePath = (p: string): string => p.replace(/\\/g, '/').split('/').filter(Boolean).join('/')

const clampToBasePath = (path: string, base: string): string => {
  const current = normalizePath(path)
  const basePath = normalizePath(base)
  if (!basePath || basePath === '.') return current
  if (current === basePath || current.startsWith(basePath + '/')) return current
  return basePath
}




interface FileBrowserProps {
  basePath?: string
  onFileSelect?: (file: FileInfo) => void
  embedded?: boolean
  initialSelectedFile?: string
  onDirectoryLoad?: (info: { workspaceRoot?: string; currentPath: string }) => void
}

export function FileBrowser({ basePath = '', onFileSelect, embedded = false, initialSelectedFile, onDirectoryLoad }: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState(basePath)
  const queryClient = useQueryClient()
  const { data: files } = useQuery<FileInfo, Error>({
    queryKey: ['files'],
    queryFn: async () => {
      if (!currentPath) return null
      const response = await fetch(`${API_BASE_URL}/api/files/${currentPath}`)
      if (!response.ok) throw new Error('Failed to load files')
      return response.json()
    },
    enabled: !!currentPath,
    staleTime: 60 * 1000,
  })
  
  const setFiles = useCallback((data: FileInfo | null) => {
    queryClient.setQueryData(['files'], data)
  }, [queryClient])
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false)
  
  const dropZoneRef = useRef<HTMLDivElement>(null)
  const isMobile = useMobile()

   const { data: initialFileData, error: initialFileError } = useFile(initialSelectedFile)

useEffect(() => {
  if (initialFileData) {
    setSelectedFile(initialFileData)
    if (isMobile) {
      setIsPreviewModalOpen(true)
    }
  }
}, [initialFileData, isMobile])

useEffect(() => {
  if (initialFileError) {
    setError(initialFileError.message)
  }
}, [initialFileError])

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
      setFiles(data)
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
      setError(err instanceof Error ? err.message : 'Failed to load file')
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

  const handleUpload = useCallback(async (files: FileList) => {
    const fileArray = Array.from(files)
    if (fileArray.length === 0) return
    let successCount = 0
    let failCount = 0
    let lastResult: { name?: string; path?: string } | null = null
    let lastError: string | null = null
    for (const file of fileArray) {
      const formData = new FormData()
      formData.append('file', file)
      try {
        const response = await fetch(`${API_BASE_URL}/api/files/${currentPath}`, {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) {
          const body = await response.json().catch(() => null)
          throw new Error(body?.error || `Upload failed: ${response.statusText}`)
        }
        lastResult = await response.json().catch(() => null)
        successCount++
      } catch (err) {
        failCount++
        lastError = err instanceof Error ? err.message : 'Upload failed'
      }
    }
    if (successCount > 0) {
      if (fileArray.length === 1) {
        showToast.success(`Uploaded "${lastResult?.name || fileArray[0].name}" to ${currentPath || '/'}`, {
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

    const droppedFiles = e.dataTransfer.files
    if (droppedFiles.length > 0) {
      await handleUpload(droppedFiles)
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

  const filteredFiles = files?.children?.filter((file: FileInfo) => file.name.toLowerCase().includes(searchQuery.toLowerCase()))

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
        <div className="flex-1 flex overflow-hidden min-h-0 h-full min-h-[600px]">
          <div className={`${isMobile ? 'w-full' : 'w-[30%] min-w-[160px]'} border-r border-border px-4 flex flex-col min-h-0 h-full`}>
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
              <Input
                placeholder="Search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1"
              />
            </div>
            
            {error && (
              <div className="text-sm text-destructive bg-destructive/10 p-2 rounded mb-4 flex-shrink-0">
                {error}
              </div>
            )}
            
            <div className="flex-1 overflow-y-auto min-h-0">
              {loading ? (
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
                  currentPath={currentPath}
                  basePath={basePath}
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
              <Input
                placeholder="Search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1"
              />
            </div>
            
            {loading ? (
              <div className="flex items-center justify-center h-64">
                <RefreshCw className="w-6 h-6 animate-spin" />
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto min-h-0">
                <FileTree
                  files={filteredFiles || []}
                  onFileSelect={handleFileSelect}
                  onDirectoryClick={handleDirectoryClick}
                  selectedFile={selectedFile}
                  onDelete={handleDelete}
                  onRename={handleRename}
                  currentPath={currentPath}
                  basePath={basePath}
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
