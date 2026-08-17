import { useState, useCallback } from 'react'
import { FileBrowser } from './FileBrowser'
import { Button } from '@/components/ui/button'
import { PathDisplay } from '@/components/ui/path-display'
import { X, Maximize2 } from 'lucide-react'

interface SessionFilePanelProps {
  basePath?: string
  repoName?: string
  initialSelectedFile?: string
  width?: number
  onClose: () => void
  onOpenFullscreen?: () => void
}

export function SessionFilePanel({ basePath = '', repoName, initialSelectedFile, width = 380, onClose, onOpenFullscreen }: SessionFilePanelProps) {
  const [displayPath, setDisplayPath] = useState<string>('/')

  const handleDirectoryLoad = useCallback((info: { workspaceRoot?: string; currentPath: string }) => {
    if (!info.currentPath || info.currentPath === '.' || info.currentPath === '') {
      setDisplayPath('/')
      return
    }

    const pathParts = info.currentPath.split('/').filter(Boolean)

    if (repoName) {
      const repoIndex = pathParts.findIndex(p => p === repoName || p.startsWith(repoName + '-'))
      if (repoIndex >= 0) {
        const subPath = pathParts.slice(repoIndex + 1)
        setDisplayPath(subPath.length > 0 ? '/' + subPath.join('/') : '/')
      } else {
        setDisplayPath('/' + pathParts.join('/'))
      }
    } else {
      setDisplayPath('/' + pathParts.join('/'))
    }
  }, [repoName])

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
          initialSelectedFile={initialSelectedFile}
          onDirectoryLoad={handleDirectoryLoad}
        />
      </div>
    </div>
  )
}