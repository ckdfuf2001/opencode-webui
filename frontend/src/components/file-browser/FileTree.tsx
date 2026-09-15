import { useState, useRef, useEffect, memo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import {
  File,
  Folder,
  FolderOpen,
  FolderUp,
  ChevronRight,
  ChevronDown,
  GripVertical,
  Trash2,
  PenLine,
  Download,
  Globe,
  ListPlus,
  Paperclip
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { FileInfo } from '@/types/files'
import { API_BASE_URL } from '@/config'
import { isBrowserViewable, openHtmlInNewTab } from '@/lib/html-view'
import { normalizeTreePath } from '@/lib/tree-path'
import { upsertHtmlPage } from '@/api/html-pages'
import { showToast } from '@/lib/toast'

interface FileTreeProps {
  files: FileInfo[]
  onFileSelect: (file: FileInfo) => void
  onDirectoryClick: (path: string) => void
  selectedFile: FileInfo | null
  onDelete: (path: string) => void
  onRename: (oldPath: string, newPath: string) => void
  onDownload?: (file: FileInfo) => void
  currentPath?: string
  basePath?: string
  isLoading?: boolean
  browserOpenPaths?: Set<string>
  attachedPaths?: Set<string>
}

interface TreeNodeProps {
  file: FileInfo
  level: number
  onFileSelect: (file: FileInfo) => void
  onDirectoryClick: (path: string) => void
  selectedFile?: FileInfo | null
  onDelete?: (path: string) => void
  onRename?: (oldPath: string, newPath: string) => void
  onDownload?: (file: FileInfo) => void
  browserOpenPaths?: Set<string>
  attachedPaths?: Set<string>
}

/**
 * 하위 폴더 지연 로딩 — FileBrowser의 경로별 캐시(['files', path])와 키를 공유해서
 * 중복 요청 없이 트리를 인라인으로 펼친다.
 */
function useDirChildren(dirPath: string, enabled: boolean) {
  return useQuery({
    queryKey: ['files', dirPath],
    queryFn: async () => {
      const response = await fetch(`${API_BASE_URL}/api/files/${dirPath}`)
      if (!response.ok) throw new Error('Failed to load files')
      return response.json() as Promise<FileInfo>
    },
    enabled,
    staleTime: 60 * 1000,
    retry: false,
  })
}

function TreeNode({ file, level, onFileSelect, onDirectoryClick, selectedFile, onDelete, onRename, onDownload, browserOpenPaths, attachedPaths }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(file.name)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const isSelected = !!selectedFile?.path && normalizeTreePath(selectedFile.path) === normalizeTreePath(file.path)
  const isBrowserOpen = !file.isDirectory && (browserOpenPaths?.has(normalizeTreePath(file.path)) ?? false)
  // 하위 폴더는 펼칠 때만 불러온다 (눌렀을 때 1회 fetch, 이후 캐시).
  // children이 이미 있으면(검색 트리 등) 추가 요청 없이 그걸 쓴다.
  const needFetch = expanded && file.isDirectory && file.children === undefined
  const { data: fetchedDir, isLoading: childrenLoading } = useDirChildren(file.path, needFetch)
  const children = file.children ?? fetchedDir?.children ?? []
  // 채팅에 첨부된 파일은 클립 표시 (정규화 후 접미 매칭 — 트리 경로는 짧고 첨부 경로는 길다)
  const isAttached = !file.isDirectory && file.path
    ? (() => {
        const p = normalizeTreePath(file.path)
        for (const a of attachedPaths ?? []) {
          if (a === p || a.endsWith('/' + p)) return true
        }
        return false
      })()
    : false

  useEffect(() => {
    if (isSelected) {
      rowRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [isSelected])

  const handleRegisterPage = async () => {
    try {
      await upsertHtmlPage({ name: file.name, kind: 'file', path: file.path })
      showToast.success(`관리 페이지에 등록: ${file.name}`)
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : '등록 실패')
    }
  }

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const handleClick = () => {
    if (editing) return
    if (file.isDirectory) {
      // 행 단일 클릭은 그 자리에서 펼치기/접기
      setExpanded((v) => !v)
    } else {
      onFileSelect(file)
    }
  }

  const handleDoubleClick = () => {
    if (editing) return
    // 더블클릭은 폴더 안으로 이동 (업로드/생성 위치, 검색 범위 기준)
    if (file.isDirectory) onDirectoryClick(file.path)
  }

  const handleDelete = () => {
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = () => {
    onDelete?.(file.path)
    setDeleteDialogOpen(false)
  }

  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false)
  }

  const handleRename = () => {
    setEditing(true)
    setEditName(file.name)
  }

  const handleRenameSubmit = () => {
    if (editName && editName !== file.name) {
      const newPath = file.path.replace(/\/[^/]+$/, `/${editName}`)
      onRename?.(file.path, newPath)
    }
    setEditing(false)
  }

  const handleRenameCancel = () => {
    setEditing(false)
    setEditName(file.name)
  }

  const getFileIcon = () => {
    if (file.isDirectory) {
      return expanded ? <FolderOpen className="w-4 h-4" /> : <Folder className="w-4 h-4" />
    }
    
    const ext = file.name.split('.').pop()?.toLowerCase()
    const iconMap: Record<string, string> = {
      'js': '🟨',
      'ts': '🔷',
      'jsx': '🟨',
      'tsx': '🔷',
      'json': '📋',
      'md': '📝',
      'html': '🌐',
      'css': '🎨',
      'png': '🖼️',
      'jpg': '🖼️',
      'jpeg': '🖼️',
      'gif': '🖼️',
      'svg': '🖼️',
      'pdf': '📄',
      'zip': '📦',
    }
    
    return (
      <span className="w-4 h-4 flex items-center justify-center text-xs">
        {iconMap[ext || ''] || <File className="w-4 h-4" />}
      </span>
    )
  }

  return (
    <div>
      <div
        ref={rowRef}
        className={`flex items-center gap-1 px-2 py-1 hover:bg-muted rounded cursor-pointer group ${
          isSelected ? 'bg-blue-500/15' : ''
        }`}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="w-6 h-6 p-0 shrink-0 opacity-70 hover:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <GripVertical className="w-3 h-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
            <DropdownMenuItem onClick={handleRename}>
              <PenLine className="w-4 h-4 mr-2" />
              Rename
            </DropdownMenuItem>
            {!file.isDirectory && isBrowserViewable(file.name) && (
              <DropdownMenuItem onClick={() => openHtmlInNewTab(file.path, file.name)}>
                <Globe className="w-4 h-4 mr-2" />
                브라우저로 열기
              </DropdownMenuItem>
            )}
            {!file.isDirectory && isBrowserViewable(file.name) && (
              <DropdownMenuItem onClick={() => void handleRegisterPage()}>
                <ListPlus className="w-4 h-4 mr-2" />
                관리 페이지로 등록
              </DropdownMenuItem>
            )}
            {onDownload && (
              <DropdownMenuItem onClick={() => onDownload(file)}>
                <Download className="w-4 h-4 mr-2" />
                {file.isDirectory ? 'Download as ZIP' : 'Download'}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={handleDelete} className="text-red-600">
              <Trash2 className="w-4 h-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {file.isDirectory && (
          <Button
            variant="ghost"
            size="sm"
            className="w-4 h-4 p-0"
            title={expanded ? '접기' : '펼치기'}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(!expanded)
            }}
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </Button>
        )}

        <div
          className="flex items-center gap-1 flex-1"
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          title={file.isDirectory ? '클릭: 펼치기/접기, 더블클릭: 폴더로 이동' : file.name}
        >
          {getFileIcon()}
          
          {editing ? (
            <Input
              ref={inputRef}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleRenameSubmit}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameSubmit()
                if (e.key === 'Escape') handleRenameCancel()
              }}
              className="h-6 text-sm"
            />
          ) : (
            <span className={`text-sm truncate ${isSelected ? 'text-blue-400 font-medium' : isBrowserOpen ? 'text-emerald-400' : ''}`}>{file.name}</span>
          )}
          {isBrowserOpen && !editing && (
            <Globe className="w-3 h-3 shrink-0 text-emerald-400" />
          )}
          {isAttached && !editing && (
            <span title="채팅에 첨부됨">
              <Paperclip className="w-3 h-3 shrink-0 text-amber-500" />
            </span>
          )}
        </div>

      </div>

      {file.isDirectory && expanded && (
        <div>
          {childrenLoading && children.length === 0 && (
            <div className="text-xs text-muted-foreground py-1" style={{ paddingLeft: `${(level + 1) * 16 + 8}px` }}>불러오는 중...</div>
          )}
          {children.map((child) => (
            <TreeNode
              key={child.path}
              file={child}
              level={level + 1}
              onFileSelect={onFileSelect}
              onDirectoryClick={onDirectoryClick}
              selectedFile={selectedFile}
              onDelete={onDelete}
              onRename={onRename}
              onDownload={onDownload}
              browserOpenPaths={browserOpenPaths}
              attachedPaths={attachedPaths}
            />
          ))}
        </div>
      )}

      <DeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
        title={`Delete ${file.isDirectory ? 'Folder' : 'File'}`}
        description={`Are you sure you want to delete this ${file.isDirectory ? 'folder' : 'file'}?`}
        itemName={file.name}
      />
    </div>
  )
}

export const FileTree = memo(function FileTree({ files, onFileSelect, onDirectoryClick, selectedFile, onDelete, onRename, onDownload, currentPath = '', basePath = '', isLoading = false, browserOpenPaths, attachedPaths }: FileTreeProps) {
  const handleGoUp = () => {
    // If currentPath has content and is different from basePath, go up
    if (currentPath !== basePath) {
      const pathParts = currentPath.split('/').filter(p => p)
      pathParts.pop()
      const parentPath = pathParts.join('/')
      onDirectoryClick(parentPath)
    }
  }

  // Show ".." if we're not at the base path (empty string means root)
  const showGoUp = currentPath && currentPath !== basePath

  return (
    <div className="min-w-max">
      {showGoUp && (
        <div
          className="flex items-center gap-1 px-2 py-1 hover:bg-muted rounded cursor-pointer group"
          onClick={handleGoUp}
          title="상위 폴더로 이동"
        >
          <span className="w-6 shrink-0" />
          <FolderUp className="w-4 h-4 shrink-0" />
          <div className="flex items-center gap-1 flex-1">
            <span className="text-sm truncate">..</span>
          </div>
        </div>
      )}
      
      {isLoading ? (
        <div className="flex flex-col gap-2 py-4 px-2">
          <div className="h-4 bg-muted rounded animate-pulse w-3/4" />
          <div className="h-4 bg-muted rounded animate-pulse w-1/2" />
          <div className="h-4 bg-muted rounded animate-pulse w-2/3" />
        </div>
      ) : files.length === 0 ? (
        <div className="text-center text-muted-foreground py-8">
          No files in this directory
        </div>
      ) : (
        files.map((file) => (
          <TreeNode
            key={file.path}
            file={file}
            level={0}
            onFileSelect={onFileSelect}
            onDirectoryClick={onDirectoryClick}
            selectedFile={selectedFile}
            onDelete={onDelete}
            onRename={onRename}
            onDownload={onDownload}
            browserOpenPaths={browserOpenPaths}
            attachedPaths={attachedPaths}
          />
        ))
      )}
    </div>
  )
})
