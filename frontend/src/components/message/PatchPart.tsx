import { useState } from 'react'
import type { components } from '@/api/opencode-types'

type PatchPart = components['schemas']['PatchPart']

interface PatchPartProps {
  part: PatchPart
}

export function PatchPart({ part }: PatchPartProps) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="border border-border rounded-lg overflow-hidden my-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2 bg-muted hover:bg-muted/80 text-left flex items-center justify-between text-sm"
      >
        <span className="font-medium">
          File Changes ({part.files.length} file{part.files.length !== 1 ? 's' : ''})
        </span>
        <span className="text-muted-foreground text-xs font-mono">{part.hash.slice(0, 8)}</span>
      </button>
      
      {expanded && (
        <div className="bg-muted/50 p-4">
          <div className="space-y-2">
            {part.files.map((file, index) => (
              <div key={index} className="text-sm">
                <div className="font-mono text-muted-foreground mb-1">{file}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
