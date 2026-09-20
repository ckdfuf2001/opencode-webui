import { useEffect, useRef } from 'react'
import type { FileHit } from '@/hooks/useFileSearch'
import { getDirectory, getFilename } from '@opencode-webui/shared'

interface FileSuggestionsProps {
  isOpen: boolean
  query: string
  files: FileHit[]
  onSelect: (file: FileHit) => void
  onClose: () => void
  position: { bottom: number, left: number, width: number, maxHeight?: number }
  selectedIndex?: number
}

export function FileSuggestions({
  isOpen,
  files,
  onSelect,
  onClose,
  position,
  selectedIndex = 0
}: FileSuggestionsProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, onClose])

  useEffect(() => {
    if (!isOpen || !listRef.current) return
    
    const selectedItem = listRef.current.children[selectedIndex] as HTMLElement
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex, isOpen])

  if (!isOpen || files.length === 0) return null

  return (
    <div
      ref={listRef}
      className="fixed bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-50 max-h-64 overflow-y-auto"
      style={{
        bottom: `${position.bottom}px`,
        left: `${position.left}px`,
        width: `${position.width}px`,
        maxHeight: position.maxHeight ? `${position.maxHeight}px` : undefined
      }}
    >
      {files.map((hit, idx) => (
        <button
          key={hit.wsPath}
          onClick={() => onSelect(hit)}
          className={`w-full px-3 py-2 text-left transition-colors ${
            idx === selectedIndex
              ? 'bg-blue-600 text-white'
              : 'hover:bg-zinc-800 text-zinc-100'
          }`}
        >
          <div className="font-mono text-sm font-medium">
            {getFilename(hit.display)}
          </div>
          <div className="text-xs opacity-70 mt-0.5">
            {getDirectory(hit.display)}
          </div>
        </button>
      ))}
    </div>
  )
}
