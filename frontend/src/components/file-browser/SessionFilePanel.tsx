import { useState, useCallback } from 'react'
import { FileBrowser } from './FileBrowser'
import { Button } from '@/components/ui/button'
import { PathDisplay } from '@/components/ui/path-display'
import { X, Maximize2 } from 'lucide-react'
import type { FileInfo } from '@/types/files'

interface SessionFilePanelProps {
  basePath?: string
  repoName?: string
  initialSelectedFile?: string
  /** 상위가 들고 있는 실시간 선택 (있으면 initialSelectedFile보다 우선). */
  selectedFilePath?: string
  width?: number
  onClose: () => void
  onOpenFullscreen?: () => void
  onMentionFile?: (file: FileInfo) => void
  onFileSelect?: (file: FileInfo) => void
}

export function SessionFilePanel({ basePath = '', repoName: _repoName, initialSelectedFile, selectedFilePath, width = 380, onClose, onOpenFullscreen, onMentionFile, onFileSelect }: SessionFilePanelProps) {
  const [displayPath, setDisplayPath] = useState<string>('/')

  const handleDirectoryLoad = useCallback((info: { workspaceRoot?: string; currentPath: string }) => {
    const norm = info.currentPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    // 레포명을 앞에 찍어 표시: /<repo>/sub 형식. 루트면 /<repo>.
    setDisplayPath(norm ? `/${norm}` : '/')
  }, [])

  return (
    <div
      className="flex flex-col border-l border-border bg-background min-h-0 h-full shrink-0 overflow-hidden"
      style={{ width }}
    >
      <div className="flex-shrink-0 border-b border-border bg-background backdrop-blur-sm px-4 py-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <PathDisplay path={displayPath} maxSegments={3} />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onOpenFullscreen && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onOpenFullscreen}
              className="text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
              title="Open fullscreen"
            >
              <Maximize2 className="w-4 h-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close explorer"
            title="탐색기 접기"
            className="text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden min-h-0">
        <FileBrowser
          basePath={basePath || '.'}
          embedded
          initialSelectedFile={selectedFilePath ?? initialSelectedFile}
          onDirectoryLoad={handleDirectoryLoad}
          onMentionFile={onMentionFile}
          onFileSelect={onFileSelect}
        />
      </div>
    </div>
  )
}