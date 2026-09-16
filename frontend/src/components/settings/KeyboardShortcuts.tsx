import { useState, useEffect } from 'react'
import { useSettings } from '@/hooks/useSettings'
import { Loader2 } from 'lucide-react'
import { DEFAULT_KEYBOARD_SHORTCUTS } from '@/api/types/settings'

const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0
const CMD_KEY = isMac ? 'Cmd' : 'Ctrl'

const normalizeShortcut = (shortcut: string): string => {
  return shortcut
    .replace(/Cmd/g, CMD_KEY)
    .replace(/\bEsc\b/g, 'Escape')
    .replace(/\bReturn\b/g, 'Enter')
}

export function KeyboardShortcuts() {
  const { preferences, isLoading, updateSettings } = useSettings()
  const [recordingKey, setRecordingKey] = useState<string | null>(null)
  const [tempShortcuts, setTempShortcuts] = useState<Record<string, string>>({})
  const [currentKeys, setCurrentKeys] = useState<string>('')

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const shortcuts = { ...DEFAULT_KEYBOARD_SHORTCUTS, ...preferences?.keyboardShortcuts, ...tempShortcuts }

  // 채팅 입력창 포커스 시 동작하는 키 vs 그 외 전역 키를 구분해서 보여준다.
  // (실제 분기는 useKeyboardShortcuts + PromptInput 핸들러와 일치시켜야 한다)
  const CHAT_ACTIONS = ['submit', 'abort', 'toggleMode', 'selectModel', 'compact']
  const chatEntries = Object.entries(shortcuts).filter(([action]) => CHAT_ACTIONS.includes(action))
  const globalEntries = Object.entries(shortcuts).filter(([action]) => !CHAT_ACTIONS.includes(action))

  const handleKeyDown = (e: KeyboardEvent, action: string) => {
    e.preventDefault()
    
    const keys = []
    if (e.ctrlKey) keys.push('Ctrl')
    if (e.metaKey) keys.push('Cmd')
    if (e.altKey) keys.push('Alt')
    if (e.shiftKey) keys.push('Shift')
    
    // Get the actual key pressed (excluding modifier keys)
    const mainKey = e.key
    if (!['Control', 'Meta', 'Alt', 'Shift'].includes(mainKey)) {
      // Handle special keys
      let displayKey = mainKey
      if (mainKey === ' ') displayKey = 'Space'
      else if (mainKey === 'ArrowUp') displayKey = 'Up'
      else if (mainKey === 'ArrowDown') displayKey = 'Down'
      else if (mainKey === 'ArrowLeft') displayKey = 'Left'
      else if (mainKey === 'ArrowRight') displayKey = 'Right'
      else if (mainKey === 'Enter') displayKey = 'Enter'
      else if (mainKey === 'Escape') displayKey = 'Escape'
      else if (mainKey === 'Tab') displayKey = 'Tab'
      else if (mainKey === 'Backspace') displayKey = 'Backspace'
      else if (mainKey === 'Delete') displayKey = 'Delete'
      else if (mainKey.length === 1) displayKey = mainKey.toUpperCase()
      
      keys.push(displayKey)
      
      // Only complete recording if we have a non-modifier key
      if (keys.length > 0) {
        const shortcut = keys.join('+')
        setTempShortcuts(prev => ({ ...prev, [action]: shortcut }))
        setRecordingKey(null)
        setCurrentKeys('')
        
        updateSettings({
          keyboardShortcuts: { ...shortcuts, [action]: shortcut }
        })
      }
    } else {
      // Show current modifier keys being held
      setCurrentKeys(keys.join('+'))
    }
  }

  const handleKeyUp = (e: KeyboardEvent) => {
    // Clear current keys display when modifiers are released
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) {
      setCurrentKeys('')
    }
  }

  const startRecording = (action: string) => {
    setRecordingKey(action)
    setCurrentKeys('')
  }

  const stopRecording = () => {
    setRecordingKey(null)
    setCurrentKeys('')
  }

  useEffect(() => {
    if (recordingKey) {
      const handleGlobalKeyDown = (e: KeyboardEvent) => {
        handleKeyDown(e, recordingKey)
      }
      
      const handleGlobalKeyUp = (e: KeyboardEvent) => {
        handleKeyUp(e)
      }
      
      document.addEventListener('keydown', handleGlobalKeyDown)
      document.addEventListener('keyup', handleGlobalKeyUp)
      return () => {
        document.removeEventListener('keydown', handleGlobalKeyDown)
        document.removeEventListener('keyup', handleGlobalKeyUp)
      }
    }
  }, [recordingKey])

  const renderRow = ([action, keys]: [string, string]) => (
    <div key={action} className="flex items-center justify-between py-3 border-b border-border last:border-0">
      <div className="space-y-1">
        <p className="text-foreground font-medium capitalize">
          {action.replace(/([A-Z])/g, ' $1').trim()}
        </p>
      </div>

      {recordingKey === action ? (
        <div className="flex items-center gap-2">
          <input
            type="text"
            className="px-3 py-1.5 bg-accent border border-primary rounded text-sm text-foreground font-mono outline-none"
            placeholder="Press keys..."
            value={currentKeys || ''}
            autoFocus
            onBlur={stopRecording}
            readOnly
          />
          <button
            onClick={stopRecording}
            className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => startRecording(action)}
          className="px-3 py-1.5 bg-accent border border-border hover:border-border rounded text-sm text-foreground font-mono transition-colors"
        >
          {normalizeShortcut(keys)}
        </button>
      )}
    </div>
  )

  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <h2 className="text-lg font-semibold text-foreground mb-6">Keyboard Shortcuts</h2>

      <h3 className="text-sm font-semibold text-foreground mt-2 mb-1">채팅창</h3>
      <p className="text-xs text-muted-foreground mb-3">채팅 입력창에 포커스가 있을 때만 동작합니다.</p>
      <div className="space-y-4 mb-6">
        {chatEntries.map(renderRow)}
      </div>

      <h3 className="text-sm font-semibold text-foreground mt-2 mb-1">전체</h3>
      <p className="text-xs text-muted-foreground mb-3">입력 중이 아닐 때 동작합니다. (브라우저 예약키 Ctrl+N/W/T 등은 가로챌 수 없습니다)</p>
      <div className="space-y-4">
        {globalEntries.map(renderRow)}
      </div>

      <p className="mt-6 text-sm text-muted-foreground">
        Click on any shortcut to record a new key combination
      </p>
    </div>
  )
}
