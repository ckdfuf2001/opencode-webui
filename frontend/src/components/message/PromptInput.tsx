import { useState, useRef, useEffect, type KeyboardEvent, type ClipboardEvent } from 'react'
import { useSendPrompt, useAbortSession, useMessages, useSendShell, useConfig, useSession } from '@/hooks/useOpenCode'
import { API_BASE_URL } from '@/config'
import { useSettings } from '@/hooks/useSettings'
import { useCommands } from '@/hooks/useCommands'
import { useCommandHandler } from '@/hooks/useCommandHandler'
import { useFileSearch } from '@/hooks/useFileSearch'

import { useUserBash } from '@/stores/userBashStore'
import { useEnqueueQueuedChat } from '@/hooks/useChatQueue'
import { ChatQueueStrip } from './ChatQueueStrip'
import { ChevronDown } from 'lucide-react'

import { CommandSuggestions } from '@/components/command/CommandSuggestions'
import { FileSuggestions } from './FileSuggestions'
import { detectMentionTrigger, parsePromptToParts, getFilename, MENTION_PATTERN } from '@/lib/promptParser'
import { getModel, formatModelName } from '@/api/providers'
import type { components } from '@/api/opencode-types'
import type { MessageWithParts, FileInfo, ContentPart } from '@/api/types'
import { getFileStat } from '@/api/files'
import { showToast } from '@/lib/toast'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type CommandType = components['schemas']['Command']

// Extended session type with model field from actual API response
type SessionWithModel = components['schemas']['Session'] & {
  model?: {
    id: string
    providerID: string
    variant?: string
  }
}

interface PromptInputProps {
  opcodeUrl: string
  directory?: string
  uploadDir?: string
  sessionID: string
  disabled?: boolean
  showScrollButton?: boolean
  onScrollToBottom?: () => void
  onShowSessionsDialog?: () => void
  onShowModelsDialog?: () => void
  onShowHelpDialog?: () => void
  injectedCommand?: { token: number; text: string; run?: boolean } | null
  onInjectedConsumed?: () => void
  injectedFile?: { token: number; files: { name: string; path: string }[] } | null
  onInjectedFileConsumed?: () => void
  injectedPrompt?: { token: number; text: string } | null
  onInjectedPromptConsumed?: () => void
  onSubmitted?: () => void
  onCancelEdit?: () => void
  editTargetMessageID?: string | null
  onResendEdit?: (messageID: string) => Promise<boolean>
}

export function PromptInput({ 
  opcodeUrl,
  directory,
  uploadDir,
  sessionID, 
  disabled,
  showScrollButton,
  onScrollToBottom,
  onShowSessionsDialog,
  onShowModelsDialog,
  onShowHelpDialog,
  injectedCommand,
  onInjectedConsumed,
  injectedFile,
  onInjectedFileConsumed,
  injectedPrompt,
  onInjectedPromptConsumed,
  onSubmitted,
  onCancelEdit,
  editTargetMessageID,
  onResendEdit
}: PromptInputProps) {
  const [prompt, setPrompt] = useState('')
  const [modelName, setModelName] = useState<string>('')
  const [isBashMode, setIsBashMode] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestionQuery, setSuggestionQuery] = useState('')
  const [suggestionPosition, setSuggestionPosition] = useState({ bottom: 0, left: 0, width: 0 })
  const [attachedFiles, setAttachedFiles] = useState(new Map<string, FileInfo>())
  const [showFileSuggestions, setShowFileSuggestions] = useState(false)
  const [fileQuery, setFileQuery] = useState('')
  const [fileSuggestionPosition, setFileSuggestionPosition] = useState({ bottom: 0, left: 0, width: 0 })
  const [mentionRange, setMentionRange] = useState<{ start: number, end: number } | null>(null)
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingRunRef = useRef<string | null>(null)
  const handleSubmitRef = useRef<() => Promise<void>>(async () => {})
  const sendPrompt = useSendPrompt(opcodeUrl, directory)
  const sendShell = useSendShell(opcodeUrl, directory)
  const abortSession = useAbortSession(opcodeUrl, directory)
  const enqueueQueued = useEnqueueQueuedChat()
  const { data: messages } = useMessages(opcodeUrl, sessionID, directory)
  const sessionData = useSession(opcodeUrl, sessionID, directory)
  const session = sessionData.data as SessionWithModel | undefined
  const { data: config } = useConfig(opcodeUrl)
  const { preferences, updateSettings } = useSettings()
  const { filterCommands, refresh: refreshCommands } = useCommands(opcodeUrl, directory)
  const { executeCommand } = useCommandHandler({
    opcodeUrl,
    sessionID,
    directory,
    onShowSessionsDialog,
    onShowModelsDialog,
    onShowHelpDialog
  })
  
  const { files: searchResults } = useFileSearch(
    fileQuery,
    showFileSuggestions,
    directory
  )
  

  const { addUserBashCommand } = useUserBash()

  const buildValidatedParts = async (): Promise<ContentPart[]> => {
    if (attachedFiles.size === 0) return parsePromptToParts(prompt, attachedFiles)

    const mentionedKeys = new Set<string>()
    for (const match of prompt.matchAll(MENTION_PATTERN)) {
      const mention = match[1] ?? match[2] ?? match[3]
      if (mention) mentionedKeys.add(mention.toLowerCase())
    }

    const validAttachments = new Map<string, FileInfo>()
    const rejected: { name: string; reason: string }[] = []
    for (const [key, file] of attachedFiles) {
      if (!mentionedKeys.has(key)) continue
      const stat = await getFileStat(file.path).catch(() => null)
      if (stat?.exists && !stat.isDirectory) {
        validAttachments.set(key, file)
      } else if (stat?.isDirectory) {
        rejected.push({ name: file.name, reason: 'is a folder, not a file' })
      } else {
        rejected.push({ name: file.name, reason: 'does not exist' })
      }
    }

    if (rejected.length > 0) {
      showToast.warning(
        `${rejected.map((r) => `"${r.name}" ${r.reason}`).join(', ')} — sent as text`,
        { duration: 5000 },
      )
    }

    return parsePromptToParts(prompt, validAttachments)
  }

  const handleSubmit = async () => {
    if (!prompt.trim() || disabled) return

    if (isBashMode) {
      const command = prompt.startsWith('!') ? prompt.slice(1) : prompt
      addUserBashCommand(command)
      sendShell.mutate({
        sessionID,
        command,
        agent: currentMode
      })
      setPrompt('')
      setIsBashMode(false)
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
      return
    }

    

    const commandMatch = prompt.match(/^\/([^\s/]+)(?:\s+(.*))?$/)
    if (commandMatch) {
      const [, commandName] = commandMatch
      const command = filterCommands(commandName)[0]
      
      if (command) {
        
        executeCommand(command, commandMatch[2] ?? '')
        setPrompt('')
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
        }
        return
      }
    }

    const parts = await buildValidatedParts()

    if (editTargetMessageID && onResendEdit) {
      const truncated = await onResendEdit(editTargetMessageID)
      if (!truncated) return
    }

    // 응답 생성 중에는 전송 대신 큐에 적재한다. 백엔드 폴러가 idle 전환 시 발송한다.
    if (hasActiveStream || sendPrompt.isPending) {
      const text = parts
        .map((part) => part.type === 'text' ? part.content : `@"${part.name}"`)
        .filter((text) => text.trim().length > 0)
        .join('\n')
      if (text.trim()) {
        enqueueQueued.mutate({ sessionID, text })
        setPrompt('')
        setAttachedFiles(new Map())
        onSubmitted?.()
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
        }
      }
      return
    }

    sendPrompt.mutate({
      sessionID,
      parts,
      model: currentModel,
      agent: currentMode
    })

    setPrompt('')
    setAttachedFiles(new Map())
    onSubmitted?.()
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleStop = () => {
    abortSession.mutate(sessionID)
  }

  // 생성 중 전송 = 큐 적재. 백엔드 폴러가 idle 전환 시 발송한다.
  const handleQueue = async () => {
    if (!prompt.trim() || disabled) return
    const parts = await buildValidatedParts()
    const text = parts
      .map((part) => (part.type === 'text' ? part.content : `@"${part.name}"`))
      .filter((text) => text.trim().length > 0)
      .join('\n')
    if (!text.trim()) return
    enqueueQueued.mutate({ sessionID, text })
    setPrompt('')
    setAttachedFiles(new Map())
    onSubmitted?.()
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleCommandSelect = async (command: CommandType) => {
    if (!textareaRef.current) return
    
    setShowSuggestions(false)
    setSuggestionQuery('')
    
    const cursorPosition = textareaRef.current.selectionStart
    const commandMatch = prompt.slice(0, cursorPosition).match(/(^|\s)\/([^\s/]*)$/)
    
    if (commandMatch) {
      const beforeCommand = prompt.slice(0, commandMatch.index)
      const afterCommand = prompt.slice(cursorPosition)
      const newPrompt = beforeCommand + '/' + command.name + ' ' + afterCommand
      
      setPrompt(newPrompt)
      
      setTimeout(() => {
        if (textareaRef.current) {
          const newCursorPos = beforeCommand.length + command.name.length + 2
          textareaRef.current.focus()
          textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
        }
      }, 0)
    }
  }
  
  const handleFileSelect = (filePath: string) => {
    if (!mentionRange || !textareaRef.current) return
    
    const relativePath = filePath.startsWith('/') ? filePath.slice(1) : filePath
    const beforeMention = prompt.slice(0, mentionRange.start)
    const afterMention = prompt.slice(mentionRange.end)
    
    const newPrompt = beforeMention + `@"${relativePath}"` + ' ' + afterMention
    setPrompt(newPrompt)
    
    const absolutePath = filePath.startsWith('/') 
      ? filePath 
      : directory 
        ? `${directory}/${filePath}` 
        : filePath
    
    setAttachedFiles(prev => {
      const next = new Map(prev)
      next.set(relativePath.toLowerCase(), {
        path: absolutePath,
        name: getFilename(relativePath)
      })
      return next
    })
    
    setShowFileSuggestions(false)
    setFileQuery('')
    setMentionRange(null)
    
    setTimeout(() => {
      if (textareaRef.current) {
        const newCursorPos = beforeMention.length + `@"${relativePath}"`.length + 1
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
      }
    }, 0)
  }

  const handleModeToggle = () => {
    const newMode = currentMode === 'plan' ? 'build' : 'plan'
    updateSettings({ mode: newMode })
  }

  const resolveFilePath = (relativePath: string): string => {
    if (!directory) return relativePath
    if (relativePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(relativePath) || relativePath.startsWith('file:')) return relativePath
    return `${directory.replace(/\\/g, '/')}/${relativePath}`
  }

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items || [])
    const files = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)

    if (files.length === 0) return
    e.preventDefault()
    if (!uploadDir) {
      showToast.error('No project folder available for upload')
      return
    }

    const uploaded: { name: string; path: string }[] = []
    let failures = 0
    for (const file of files) {
      const formData = new FormData()
      formData.append('file', file)
      try {
        const res = await fetch(`${API_BASE_URL}/api/files/${uploadDir}`, {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          failures++
          continue
        }
        const data = await res.json().catch(() => null)
        const savedName: string = data?.name || file.name
        uploaded.push({ name: savedName, path: `chat_uploads/${savedName}` })
      } catch {
        failures++
        continue
      }
    }

    if (uploaded.length === 0) {
      showToast.error('Upload failed')
      return
    }
    if (failures > 0) {
      showToast.error(`${failures} of ${files.length} file(s) failed to upload`)
    }
    showToast.success(`Uploaded ${uploaded.length} file(s) to project`, { duration: 5000 })

    const el = textareaRef.current
    const insertions = uploaded.map((file) => {
      const relativePath = file.path.startsWith('/') ? file.path.slice(1) : file.path
      const mention = `@"${relativePath}"`
      return { relativePath, mention, name: file.name }
    })

    setPrompt(prev => `${prev}${insertions.map(i => i.mention).join(' ')} `.trimStart())
    setAttachedFiles(prev => {
      const next = new Map(prev)
      for (const i of insertions) {
        next.set(i.relativePath.toLowerCase(), {
          path: resolveFilePath(i.relativePath),
          name: i.name,
        })
      }
      return next
    })
    if (el) {
      el.focus()
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isBashMode && e.key === 'Escape') {
      e.preventDefault()
      setIsBashMode(false)
      setPrompt('')
      return
    }

    if (showFileSuggestions && searchResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedFileIndex(prev => 
          prev < searchResults.length - 1 ? prev + 1 : prev
        )
        return
      }
      
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedFileIndex(prev => prev > 0 ? prev - 1 : 0)
        return
      }
      
      if (e.key === 'Enter') {
        e.preventDefault()
        if (searchResults[selectedFileIndex]) {
          handleFileSelect(searchResults[selectedFileIndex])
        }
        return
      }
      
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowFileSuggestions(false)
        setFileQuery('')
        setMentionRange(null)
        return
      }
    }
    
    if (showSuggestions) {
      const filteredCommands = filterCommands(suggestionQuery)
      
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedCommandIndex(prev => (prev + 1) % filteredCommands.length)
        return
      }
      
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedCommandIndex(prev => (prev - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      
      if (e.key === 'Enter') {
        e.preventDefault()
        const selectedCommand = filteredCommands[selectedCommandIndex]
        if (selectedCommand) {
          handleCommandSelect(selectedCommand)
        }
        return
      }
      
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowSuggestions(false)
        setSuggestionQuery('')
        setSelectedCommandIndex(0)
        return
      }
    }
    
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
      setSuggestionQuery('')
      setShowFileSuggestions(false)
      setFileQuery('')
      setMentionRange(null)
      setPrompt('')
      onCancelEdit?.()
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    
    if (value === '!' && prompt === '') {
      setIsBashMode(true)
      setPrompt(value)
      return
    }
    
    if (isBashMode && value === '') {
      setIsBashMode(false)
    }
    
    setPrompt(value)
    
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }

    if (isBashMode) {
      return
    }

    const cursorPosition = e.target.selectionStart
    
    const mentionTrigger = detectMentionTrigger(value, cursorPosition)
    
    if (mentionTrigger) {
      setFileQuery(mentionTrigger.query)
      setMentionRange({ start: mentionTrigger.start, end: mentionTrigger.end })
      setShowFileSuggestions(true)
      setSelectedFileIndex(0)
      
      if (textareaRef.current) {
        const rect = textareaRef.current.getBoundingClientRect()
        setFileSuggestionPosition({
          bottom: window.innerHeight - rect.top + window.scrollY + 4,
          left: rect.left + window.scrollX,
          width: rect.width
        })
      }
    } else {
      const commandMatch = value.slice(0, cursorPosition).match(/(^|\s)\/([^\s/]*)$/)
      
      if (commandMatch) {
        const query = commandMatch[2]
        setSuggestionQuery(query)
        setShowSuggestions(true)
        setSelectedCommandIndex(0)
        
        if (textareaRef.current) {
          const rect = textareaRef.current.getBoundingClientRect()
          setSuggestionPosition({
            bottom: window.innerHeight - rect.top + window.scrollY + 4,
            left: rect.left + window.scrollX,
            width: rect.width
          })
        }
      } else {
        setShowSuggestions(false)
        setSuggestionQuery('')
      }
      
      if (showFileSuggestions) {
        setShowFileSuggestions(false)
        setFileQuery('')
        setMentionRange(null)
      }
    }
  }

  const isMessageStreaming = (msg: MessageWithParts): boolean => {
    if (msg.info.role !== 'assistant') return false
    return !('completed' in msg.info.time && msg.info.time.completed)
  }

  const hasActiveStream = messages?.some(msg => isMessageStreaming(msg)) || false
  // 전송 POST는 턴이 끝날 때까지 대기하므로 isPending = 생성 중 신호 (폴링보다 즉각적).
  const showStop = hasActiveStream || sendPrompt.isPending

  const currentMode = preferences?.mode || 'build'
  const modeColor = currentMode === 'plan' ? 'text-yellow-600 dark:text-yellow-500' : 'text-green-600 dark:text-green-500'
  const modeBg = currentMode === 'plan' ? 'bg-yellow-500/10 border-yellow-500/30' : 'bg-green-500/10 border-green-500/30'

  const sessionModel = session?.model?.providerID && session?.model?.id
    ? `${session.model.providerID}/${session.model.id}`
    : null
  const currentModel = sessionModel || config?.model || preferences?.defaultModel || ''

  useEffect(() => {
    const loadModelName = async () => {
      if (currentModel) {
        try {
          const [providerId, modelId] = currentModel.split('/')
          if (providerId && modelId) {
            const model = await getModel(providerId, modelId)
            if (model) {
              setModelName(formatModelName(model))
            } else {
              setModelName(currentModel)
            }
          } else {
            setModelName(currentModel)
          }
        } catch {
          setModelName(currentModel)
        }
      } else {
        setModelName('No model selected')
      }
    }

    loadModelName()
  }, [currentModel])

  useEffect(() => {
    if (textareaRef.current && !disabled && !hasActiveStream) {
      textareaRef.current.focus()
    }
  }, [disabled, hasActiveStream])

  useEffect(() => {
    if (!injectedCommand) return
    setPrompt(injectedCommand.text)
    const el = textareaRef.current
    if (el) {
      el.focus()
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
      const pos = injectedCommand.text.length
      el.setSelectionRange(pos, pos)
    }
    if (injectedCommand.run) {
      pendingRunRef.current = injectedCommand.text
    }
    onInjectedConsumed?.()
  }, [injectedCommand, onInjectedConsumed])

  useEffect(() => {
    if (!injectedPrompt) return
    setPrompt(injectedPrompt.text)
    const el = textareaRef.current
    if (el) {
      el.focus()
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
      const pos = injectedPrompt.text.length
      el.setSelectionRange(pos, pos)
    }
    onInjectedPromptConsumed?.()
  }, [injectedPrompt, onInjectedPromptConsumed])

  useEffect(() => {
    const handleCommandsRefreshed = () => {
      refreshCommands()
    }
    window.addEventListener('opencode:commands-refreshed', handleCommandsRefreshed)
    return () => {
      window.removeEventListener('opencode:commands-refreshed', handleCommandsRefreshed)
    }
  }, [refreshCommands])

  useEffect(() => {
    handleSubmitRef.current = handleSubmit
  }, [handleSubmit])

  useEffect(() => {
    if (!injectedFile || injectedFile.files.length === 0) return
    const el = textareaRef.current
    let nextPrompt = prompt
    const nextAttached = new Map(attachedFiles)
    for (const file of injectedFile.files) {
      const relativePath = file.path.startsWith('/') ? file.path.slice(1) : file.path
      const mention = `@"${relativePath}"`
      nextPrompt = `${nextPrompt}${mention} `.trimStart()
      nextAttached.set(relativePath.toLowerCase(), {
        path: resolveFilePath(relativePath),
        name: file.name,
      })
    }
    setPrompt(nextPrompt)
    setAttachedFiles(nextAttached)
    if (el) {
      el.focus()
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
    onInjectedFileConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectedFile, onInjectedFileConsumed])

  useEffect(() => {
    if (pendingRunRef.current && prompt === pendingRunRef.current) {
      pendingRunRef.current = null
      handleSubmitRef.current()
    }
  }, [prompt])

  

  return (
    <div className="backdrop-blur-md bg-background opacity-95 border border-border rounded-xl p-2 md:p-3 mx-2 md:mx-4 mb-2 md:mb-5 w-[90%] md:max-w-4xl">
      <ChatQueueStrip sessionID={sessionID} />
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={
          isBashMode
            ? "Enter bash command..."
            : showStop
              ? "Queue a message — it will send after the current response..."
              : "Send a message..."
        }
        disabled={disabled}
        className={`w-full bg-background/90 px-2 md:px-3 py-2 text-[16px] text-foreground placeholder-muted-foreground focus:outline-none focus:bg-background resize-none min-h-[40px] max-h-[120px] disabled:opacity-50 disabled:cursor-not-allowed md:text-sm rounded-lg ${
          isBashMode 
            ? 'border-purple-500/50 bg-purple-500/5' 
            : ''
        }`}
        rows={1}
      />
      
      <div className="flex gap-1.5 md:gap-2 items-center justify-between">
        <div className="flex gap-1.5 md:gap-2 items-center">
          <button
            onClick={handleModeToggle}
            className={`px-2 py-1 rounded-md text-xs font-medium border w-14 ${
              isBashMode 
                ? 'bg-purple-500/10 border-purple-500/30 text-purple-600 dark:text-purple-400' 
                : `${modeBg} ${modeColor}`
            } hover:opacity-80 transition-opacity cursor-pointer`}
          >
            {isBashMode ? 'BASH' : currentMode.toUpperCase()} 
          </button>
          <button
            onClick={onShowModelsDialog}
            className="px-2 py-1 rounded-md text-xs font-medium border bg-muted border-border text-muted-foreground hover:bg-muted-foreground/10 transition-colors cursor-pointer max-w-[120px] md:max-w-[180px] truncate"
          >
            {modelName.length > 12 ? modelName.substring(0, 10) + '...' : modelName || 'Select model'}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="w-6 h-6 rounded-full border-2 border-foreground text-foreground hover:bg-foreground hover:text-background transition-colors flex items-center justify-center text-sm font-medium flex-shrink-0"
                title="Help"
              >
                ?
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem disabled className="text-xs text-muted-foreground font-medium">
                Keyboard Shortcuts
              </DropdownMenuItem>
              <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                <span className="font-mono">Cmd/Ctrl+Enter</span> - Send message
              </DropdownMenuItem>
              <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                <span className="font-mono">@"</span> - Mention files
              </DropdownMenuItem>
              <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                <span className="font-mono">!</span> - Bash command mode
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex items-center gap-1.5 md:gap-2 flex-shrink-0">
          {showScrollButton && (
            <button
              onClick={onScrollToBottom}
              className="p-1.5 md:p-2 rounded-lg bg-muted hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground transition-colors border border-foreground/30"
              title="Scroll to bottom"
            >
              <ChevronDown className="w-5 h-5" />
            </button>
          )}
          {showStop && (
            <button
              onClick={handleStop}
              className="px-4 md:px-5 py-1.5 rounded-lg text-sm font-medium bg-destructive hover:bg-destructive/90 text-destructive-foreground transition-colors"
              title="Stop generating"
            >
              Stop
            </button>
          )}
          <button
            data-submit-prompt
            onClick={showStop ? handleQueue : handleSubmit}
            disabled={(!prompt.trim() && !showStop) || disabled}
            className={`px-5 md:px-6 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              showStop
                ? 'bg-blue-600 hover:bg-blue-600/90 text-white'
                : 'bg-primary hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed text-primary-foreground'
            }`}
            title={showStop ? 'Queue message' : 'Send'}
          >
            {showStop ? 'Queue' : 'Send'}
          </button>
        </div>
      </div>
      
      <CommandSuggestions
        isOpen={showSuggestions}
        query={suggestionQuery}
        commands={filterCommands(suggestionQuery)}
        onSelect={handleCommandSelect}
        onClose={() => {
          setShowSuggestions(false)
          setSuggestionQuery('')
        }}
        position={suggestionPosition}
        selectedIndex={selectedCommandIndex}
      />
      
      <FileSuggestions
        isOpen={showFileSuggestions}
        query={fileQuery}
        files={searchResults}
        onSelect={handleFileSelect}
        onClose={() => {
          setShowFileSuggestions(false)
          setFileQuery('')
          setMentionRange(null)
        }}
        position={fileSuggestionPosition}
        selectedIndex={selectedFileIndex}
      />
    </div>
  )
}
