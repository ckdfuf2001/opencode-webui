import { useState, useRef, useEffect, memo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import {
  File,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Ellipsis,
  Trash2,
  PenLine,
  Download,
  Globe,
  ListPlus
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { FileInfo } from '@/types/files'
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
}

function TreeNode({ file, level, onFileSelect, onDirectoryClick, selectedFile, onDelete, onRename, onDownload, browserOpenPaths }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(file.name)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const isSelected = !!selectedFile?.path && normalizeTreePath(selectedFile.path) === normalizeTreePath(file.path)
  const isBrowserOpen = !file.isDirectory && (browserOpenPaths?.has(normalizeTreePath(file.path)) ?? false)

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
      onDirectoryClick(file.path)
    } else {
      onFileSelect(file)
    }
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
        {file.isDirectory && (
          <Button
            variant="ghost"
            size="sm"
            className="w-4 h-4 p-0"
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(!expanded)
              if (!expanded) {
                onDirectoryClick(file.path)
              }
            }}
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </Button>
        )}
        
        <div className="flex items-center gap-1 flex-1" onClick={handleClick}>
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
        </div>
        
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="w-6 h-6 p-0 shrink-0 opacity-70 hover:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Ellipsis className="w-3 h-3" />
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
      </div>
      
      {file.isDirectory && expanded && file.children && (
        <div>
          {file.children.map((child) => (
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

export const FileTree = memo(function FileTree({ files, onFileSelect, onDirectoryClick, selectedFile, onDelete, onRename, onDownload, currentPath = '', basePath = '', isLoading = false, browserOpenPaths }: FileTreeProps) {
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
          className="flex items-center gap-1 px-2 py-1 hover:bg-muted rounded cursor-pointer"
          onClick={handleGoUp}
        >
          <span className="text-sm text-muted-foreground">..</span>
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
          />
        ))
      )}
    </div>
  )
})
