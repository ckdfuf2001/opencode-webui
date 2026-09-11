import { useState, useRef, useEffect, type KeyboardEvent, type ClipboardEvent } from 'react'
import { useSendPrompt, useAbortSession, useMessages, useSendShell, useConfig, useSession, isRecentlyAborted, useSessionStatusMap } from '@/hooks/useOpenCode'
import { API_BASE_URL } from '@/config'
import { useSettings } from '@/hooks/useSettings'
import { useCommands } from '@/hooks/useCommands'
import { useCommandHandler } from '@/hooks/useCommandHandler'
import { useFileSearch } from '@/hooks/useFileSearch'

import { useUserBash } from '@/stores/userBashStore'
import { useEnqueueQueuedChat } from '@/hooks/useChatQueue'
import { listQueuedChats } from '@/api/chat-queue'
import { ChatQueueStrip } from './ChatQueueStrip'
import { useContextUsage } from '@/hooks/useContextUsage'

import { CommandSuggestions } from '@/components/command/CommandSuggestions'
import { FileSuggestions } from './FileSuggestions'
import { detectMentionTrigger, parsePromptToParts, getFilename, MENTION_PATTERN } from '@/lib/promptParser'
import { getModel, formatModelName } from '@/api/providers'
import type { components } from '@/api/opencode-types'
import type { MessageWithParts, FileInfo, ContentPart } from '@/api/types'
import { getFileStat, uploadFileWithProgress, isUploadInFlight, DuplicateUploadError } from '@/api/files'
import { showToast } from '@/lib/toast'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'

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
  autoScrollEnabled?: boolean
  onAutoScrollChange?: (enabled: boolean) => void
  onCompact?: () => void
  onNewSession?: () => void
  isStreaming?: boolean
}

export function PromptInput({ 
  opcodeUrl,
  directory,
  uploadDir,
  sessionID, 
  disabled,
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
  onResendEdit,
  autoScrollEnabled,
  onAutoScrollChange,
  isStreaming: isStreamingProp
}: PromptInputProps) {
  const [prompt, setPrompt] = useState('')
  const [modelName, setModelName] = useState<string>('')
  const [isBashMode, setIsBashMode] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestionQuery, setSuggestionQuery] = useState('')
  const [suggestionPosition, setSuggestionPosition] = useState({ bottom: 0, left: 0, width: 0, maxHeight: 256 })
  const [attachedFiles, setAttachedFiles] = useState(new Map<string, FileInfo>())
  const [uploadProgress, setUploadProgress] = useState<{ name: string; loaded: number; total: number; index: number; count: number } | null>(null)
  const [showFileSuggestions, setShowFileSuggestions] = useState(false)
  const [fileQuery, setFileQuery] = useState('')
  const [fileSuggestionPosition, setFileSuggestionPosition] = useState({ bottom: 0, left: 0, width: 0, maxHeight: 256 })

  /**
   * 슬래시(/)/멘션(@) 헬퍼 팝업을 textarea 위쪽에 고정 배치한다.
   * 모바일(특히 iOS Safari)에선 키보드가 뜨면 window.innerHeight 는 그대로고
   * visualViewport 만 줄어들어서, 팝업이 보이는 영역 위로 밀려나 사라졌다.
   * visualViewport 기준으로 textarea 위쪽 가용 높이를 계산해 maxHeight 로 clamp 한다.
   */
  const updateSuggestionAnchor = (el: HTMLElement, kind: 'command' | 'file') => {
    const rect = el.getBoundingClientRect()
    const vv = window.visualViewport
    const visibleTop = vv ? vv.offsetTop : 0
    const availableAbove = Math.max(140, rect.top - visibleTop - 8)
    const next = {
      bottom: window.innerHeight - rect.top + 4,
      left: rect.left,
      width: rect.width,
      maxHeight: Math.round(Math.min(256, availableAbove)),
    }
    if (kind === 'command') setSuggestionPosition(next)
    else setFileSuggestionPosition(next)
  }
  const [mentionRange, setMentionRange] = useState<{ start: number, end: number } | null>(null)
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingRunRef = useRef<string | null>(null)
  // Ctrl+Enter 연타 시 async 준비 구간 중복 실행 방지
  const submitGuardRef = useRef(false)
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
const ks = preferences?.keyboardShortcuts
const submitKs = ks?.submit ?? 'Ctrl+Enter'
const abortKs = ks?.abort ?? 'Escape'
const toggleModeKs = ks?.toggleMode ?? 'Tab'
const selectModelKs = ks?.selectModel ?? 'Ctrl+M'
const { commands, filterCommands, refreshIfStale, refresh: refreshCommands } = useCommands(opcodeUrl, directory)
  // 슬래시 커맨드도 큐 경유로 바뀌어 executeCommand 직접 호출은 없다.
  // (훅 자체는 유지 — 내부 콜백/상태 초기화용)
  useCommandHandler({
    opcodeUrl,
    sessionID,
    directory,
    commands,
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
  const { totalTokens, contextLimit, usagePercentage } = useContextUsage(opcodeUrl, sessionID, directory)
  const usage = usagePercentage ?? 0
  const isContextWarning = usage >= 90 && usage < 95
  const isContextCritical = usage >= 95
  const estimatedInputTokens = Math.ceil(prompt.length / 4)
  const projectedUsage = contextLimit ? ((totalTokens + estimatedInputTokens) / contextLimit) * 100 : 0
  const willExceed = contextLimit ? projectedUsage >= 95 : false

  // 파일 파트는 텍스트로 바꿀 때 위치가 포함되어야 나중에 칩으로 인식된다.
  // 파일명만 넣으면("...") 존재 확인이 안 돼 아이콘 표시도 안 된다.
  const partToText = (part: ContentPart): string => {
    if (part.type === 'text') return part.content
    const norm = part.path.replace(/\\/g, '/')
    const dir = (directory ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    const rel = dir && norm.startsWith(dir + '/') ? norm.slice(dir.length + 1) : part.name
    return `@"${rel}"`
  }

  // 첫 전송도 큐 경유라 모델/에이전트 선택이 큐에 타야 한다 (직접 전송과 동일값).
  const queueDispatchOpts = (): { model?: { providerID: string; modelID: string }; agent?: string } => {
    const slash = currentModel.indexOf('/')
    const providerID = slash > 0 ? currentModel.slice(0, slash) : ''
    const modelID = slash > 0 ? currentModel.slice(slash + 1) : ''
    return {
      ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
      ...(currentMode ? { agent: currentMode } : {}),
    }
  }

  const buildValidatedParts = async (): Promise<ContentPart[]> => {    if (attachedFiles.size === 0) return parsePromptToParts(prompt, attachedFiles)

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
    if (isContextCritical || willExceed) {
      showToast.error(`Context ${Math.round(usage)}% exceeded — send blocked. Use Scissors to truncate previous messages or start a new session. (${totalTokens.toLocaleString()} / ${contextLimit?.toLocaleString()} tokens)`, { duration: 6000 })
      return
    }
    if (isContextWarning) {
      showToast.warning(`Context ${Math.round(usage)}% — the limit is close. Truncate unnecessary messages.`, { duration: 4000 })
    }

    if (submitGuardRef.current) return
    submitGuardRef.current = true
    try {

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
        // 커맨드도 큐 경유 — 스킬은 템플릿 전체를, 일반 커맨드는 /name args를 큐에 넣는다
        // 배치(큐)는 opencode의 /command 엔드포인트로 실행되어 설명이 아닌 실제 수행이 된다
        const isSkill = (command as { source?: string }).source === 'skill'
        const args = commandMatch[2] ?? ''
        const text = isSkill
          ? (args ? `${(command as { template?: string }).template ?? `/${command.name}`}\n\n${args}` : ((command as { template?: string }).template ?? `/${command.name}`))
          : prompt.trim()
        if (text) {
          enqueueQueued.mutate({ sessionID, text, directory, ...queueDispatchOpts() })
          setPrompt('')
          setAttachedFiles(new Map())
          onSubmitted?.()
          if (textareaRef.current) textareaRef.current.style.height = 'auto'
        }
        return
      }
    }

    const parts = await buildValidatedParts()

    if (editTargetMessageID && onResendEdit) {
      const truncated = await onResendEdit(editTargetMessageID)
      if (!truncated) return
    }

    // 응답 생성 중이거나 cancel 처리 중에는 전송 대신 큐에 적재한다.
    // cancel 직후 프론트는 idle로 보여도 서버가 abort 중이라 직접 보내면 유실/역전된다.
    // 백엔드 폴러가 실제 idle 확인 후 순서대로 발송한다.
    const aborting = abortSession.isPending || isRecentlyAborted(sessionID)
    if (hasActiveStream || sendPrompt.isPending || aborting) {
      const text = parts
        .map(partToText)
        .filter((text) => text.trim().length > 0)
        .join('\n')
      if (text.trim()) {
        enqueueQueued.mutate({ sessionID, text, directory, ...queueDispatchOpts() })
        setPrompt('')
        setAttachedFiles(new Map())
        onSubmitted?.()
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
        }
      }
      return
    }

    // 백엔드 큐에 대기 중인 메시지가 있으면 순서 보존을 위해 뒤에 적재한다.
    // (cancel 후 바로 보내면 새 채팅이 먼저 뜨고 큐 내용이 나중에 위로 뜨는 역전 방지)
    try {
      const pending = await listQueuedChats(sessionID).catch(() => [])
      if (pending.length > 0) {
        const text = parts
          .map(partToText)
          .filter((t) => t.trim().length > 0)
          .join('\n')
        if (text.trim()) {
          enqueueQueued.mutate({ sessionID, text, directory, ...queueDispatchOpts() })
          setPrompt('')
          setAttachedFiles(new Map())
          onSubmitted?.()
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'
          }
        }
        return
      }
    } catch {
      // 조회 실패 시 기존대로 직접 전송 (fail-open)
    }

    // 첫 전송도 큐 경유: 스트립에 sending 표시가 뜨고 응답 확인 후 제거된다.
    const finalText = parts
      .map(partToText)
      .filter((t) => t.trim().length > 0)
      .join('\n')
    if (!finalText.trim()) return
    enqueueQueued.mutate({ sessionID, text: finalText, directory, ...queueDispatchOpts() })

    setPrompt('')
    setAttachedFiles(new Map())
    onSubmitted?.()
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    } finally {
      submitGuardRef.current = false
    }
  }

  const handleStop = () => {
    abortSession.mutate(sessionID)
    onCancelEdit?.()
  }

  // 생성 중 전송 = 큐 적재. 백엔드 폴러가 idle 전환 시 발송한다.
  const handleQueue = async () => {
    if (!prompt.trim() || disabled) return
    if (isContextCritical || willExceed) {
      showToast.error(`Context ${Math.round(usage)}% exceeded — queueing blocked. Clean up the conversation first.`, { duration: 6000 })
      return
    }
    const parts = await buildValidatedParts()
    const text = parts
      .map(partToText)
      .filter((text) => text.trim().length > 0)
      .join('\n')
    if (!text.trim()) return
    // 첫 전송도 큐 경유: 스트립에 sending 표시가 뜨고 응답 확인 후 제거된다.
    enqueueQueued.mutate({ sessionID, text, directory, ...queueDispatchOpts() })
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

    const fresh = files.filter((f) => !isUploadInFlight(f))
    if (fresh.length < files.length) {
      showToast.info(`이미 업로드 중인 ${files.length - fresh.length}개 파일은 제외합니다`)
    }
    if (fresh.length === 0) return
    const uploaded: { name: string; path: string }[] = []
    let failures = 0
    // 영역을 즉시 띄우고 (첫 paint 확보), 진행 콜백은 스로틀로 렌더 폭풍 방지
    setUploadProgress({ name: fresh[0].name, loaded: 0, total: fresh[0].size || 1, index: 1, count: fresh.length })
    let lastProgAt = 0
    for (let i = 0; i < fresh.length; i++) {
      const file = fresh[i]
      setUploadProgress({ name: file.name, loaded: 0, total: file.size || 1, index: i + 1, count: fresh.length })
      try {
        const data = await uploadFileWithProgress(`${API_BASE_URL}/api/files/${uploadDir}`, file, (loaded, total) => {
          const now = Date.now()
          if (now - lastProgAt < 150) return
          lastProgAt = now
          setUploadProgress({ name: file.name, loaded, total: total || file.size || 1, index: i + 1, count: fresh.length })
        })
        const savedName: string = data?.name || file.name
        uploaded.push({ name: savedName, path: `chat_uploads/${savedName}` })
      } catch (e) {
        if (e instanceof DuplicateUploadError) continue
        failures++
        continue
      }
    }
    setUploadProgress(null)

    if (uploaded.length === 0) {
      showToast.error('Upload failed')
      return
    }
    if (failures > 0) {
      showToast.error(`${failures} of ${fresh.length} file(s) failed to upload`)
    }
    showToast.success(`Uploaded ${uploaded.length} file(s) to project`, { duration: 5000 })

    const el = textareaRef.current
    const insertions = uploaded.map((file) => {
      const relativePath = file.path.startsWith('/') ? file.path.slice(1) : file.path
      const mention = `@"${relativePath}"`
      return { relativePath, mention, name: file.name }
    })

    setPrompt(prev => `${prev ? `${prev} ` : ''}${insertions.map(i => i.mention).join(' ')} `)
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
        updateSuggestionAnchor(textareaRef.current, 'file')
      }
    } else {
      const commandMatch = value.slice(0, cursorPosition).match(/(^|\s)\/([^\s/]*)$/)

      if (commandMatch) {
        const query = commandMatch[2]
        setSuggestionQuery(query)
        setShowSuggestions(true)
        setSelectedCommandIndex(0)
        // 슬래시 입력 시 항상 백그라운드로 새로 받는다 (커맨드 생성 직후에도 즉시 보이도록)
        refreshIfStale(0)

        if (textareaRef.current) {
          updateSuggestionAnchor(textareaRef.current, 'command')
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

  const { data: dbStatusesInner } = useSessionStatusMap()
  const dbBusyInner = !!sessionID && dbStatusesInner?.some((s) => s.sessionId === sessionID && s.status === 'busy') === true
  const abortedRecently = isRecentlyAborted(sessionID)
  const hasActiveStreamLocal = messages?.some(msg => isMessageStreaming(msg)) || false
  const hasActiveStream = abortedRecently ? false : (isStreamingProp ?? (hasActiveStreamLocal || dbBusyInner))
  // 전송 POST는 턴이 끝날 때까지 대기하므로 isPending = 생성 중 신호 (폴링보다 즉각적). abort 직후엔 강제로 숨긴다.
  const showStop = !abortedRecently && (hasActiveStream || sendPrompt.isPending)

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

  // 키보드가 뜨거나 접히며 visualViewport 가 변하면 열려 있는 헬퍼 팝업을 다시 앵커한다.
  useEffect(() => {
    if (!showSuggestions && !showFileSuggestions) return
    const el = textareaRef.current
    if (!el) return
    const reanchor = () => {
      if (showSuggestions) updateSuggestionAnchor(el, 'command')
      if (showFileSuggestions) updateSuggestionAnchor(el, 'file')
    }
    window.visualViewport?.addEventListener('resize', reanchor)
    window.visualViewport?.addEventListener('scroll', reanchor)
    return () => {
      window.visualViewport?.removeEventListener('resize', reanchor)
      window.visualViewport?.removeEventListener('scroll', reanchor)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSuggestions, showFileSuggestions])

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
    const mentions = injectedFile.files.map((file) => {
      const relativePath = file.path.startsWith('/') ? file.path.slice(1) : file.path
      return { relativePath, mention: `@"${relativePath}"`, name: file.name }
    })
    setPrompt((prev) => {
      const prefix = prev ? `${prev} ` : ''
      return `${prefix}${mentions.map((m) => m.mention).join(' ')} `.trimStart()
    })
    setAttachedFiles((prev) => {
      const next = new Map(prev)
      for (const m of mentions) {
        next.set(m.relativePath.toLowerCase(), {
          path: resolveFilePath(m.relativePath),
          name: m.name,
        })
      }
      return next
    })
    const el = textareaRef.current
    if (el) {
      requestAnimationFrame(() => {
        el.focus()
        el.style.height = 'auto'
        el.style.height = `${el.scrollHeight}px`
      })
    }
    onInjectedFileConsumed?.()
  }, [injectedFile, onInjectedFileConsumed])

  useEffect(() => {
    if (pendingRunRef.current && prompt === pendingRunRef.current) {
      pendingRunRef.current = null
      handleSubmitRef.current()
    }
  }, [prompt])

  

  return (
    <div className="backdrop-blur-md bg-background opacity-95 border border-border rounded-xl p-2 mx-2 mb-2 w-[90%] max-w-4xl">
      <ChatQueueStrip sessionID={sessionID} />
      {uploadProgress && (
        <div className="mb-2 px-3 py-2 rounded-lg text-xs bg-blue-500/10 border border-blue-500/30 text-blue-600 dark:text-blue-400">
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
      {/* 컨텍스트 경고는 헤더 아래 최상단 배너로 이동 (SessionDetail).
          여기는 전송 차단/토스트 로직만 유지한다. */}
      {(isContextCritical || willExceed) && contextLimit && (
        <div className="mb-2 px-3 py-2 rounded-lg text-xs flex items-center justify-between gap-2 bg-red-500/15 border border-red-500/40 text-red-400">
          <span className="flex-1 min-w-0">
            {`Context exceeded ${Math.round(usage)}% (${totalTokens.toLocaleString()} / ${contextLimit.toLocaleString()}) — sending is blocked.`}
          </span>
          {willExceed && <span className="ml-2 font-mono text-[10px] opacity-70 hidden sm:inline">projected {Math.round(projectedUsage)}%</span>}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={() => refreshIfStale(0)}
        placeholder={
          isBashMode
            ? "Enter bash command..."
            : showStop
              ? "Queue a message — it will send after the current response..."
              : "Send a message..."
        }
        disabled={disabled}
        className={`w-full bg-background/90 px-2 py-2 text-[16px] text-foreground placeholder-muted-foreground focus:outline-none focus:bg-background resize-none min-h-[40px] max-h-[120px] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg ${
          isBashMode 
            ? 'border-purple-500/50 bg-purple-500/5' 
            : ''
        }`}
        rows={1}
      />
      
      <div className="flex gap-1.5 items-center justify-between">
        <div className="flex gap-1.5 items-center flex-1 min-w-0">
          <button
            onClick={handleModeToggle}
            title={isBashMode ? 'Bash mode (Esc to exit)' : `Switch build/plan (${toggleModeKs})`}
            className={`px-2 py-1 rounded-md text-xs font-medium border w-14 flex-shrink-0 ${
              isBashMode 
                ? 'bg-purple-500/10 border-purple-500/30 text-purple-600 dark:text-purple-400' 
                : `${modeBg} ${modeColor}`
            } hover:opacity-80 transition-opacity cursor-pointer`}
          >
            {isBashMode ? 'BASH' : currentMode.toUpperCase()} 
          </button>
<div className="flex items-center space-x-2 min-w-0">
  <button
    onClick={onShowModelsDialog}
    title={modelName ? `${modelName} (${selectModelKs})` : `Select model (${selectModelKs})`}
    className="px-2 py-1 rounded-md text-xs font-medium border bg-muted border-border text-muted-foreground hover:bg-muted-foreground/10 transition-colors cursor-pointer max-w-[80px] sm:max-w-[120px] truncate shrink min-w-0"
  >
    {modelName.length > 12 ? modelName.substring(0, 10) + '...' : modelName || 'Select model'}
  </button>
</div>
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
                <span className="font-mono">Cmd/Ctrl+Enter</span>{' '}- Send message
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
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {onAutoScrollChange && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full border border-border/30 bg-muted/30" title="Auto scroll on/off">
              <span className="hidden sm:inline text-xs text-muted-foreground whitespace-nowrap">Auto Scroll</span>
              <Switch checked={!!autoScrollEnabled} onCheckedChange={onAutoScrollChange} className="scale-75" />
            </div>
          )}
          {showStop && (
            <button
              onClick={handleStop}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-destructive hover:bg-destructive/90 text-destructive-foreground transition-colors"
              title={`Stop generating (${abortKs})`}
            >
              Stop
            </button>
          )}
          <button
            data-submit-prompt
            onClick={showStop ? handleQueue : handleSubmit}
            disabled={(!prompt.trim() && !showStop) || disabled || isContextCritical || willExceed}
            className={`px-5 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              isContextCritical || willExceed
                ? 'bg-muted text-muted-foreground cursor-not-allowed opacity-50'
                : showStop
                  ? 'bg-blue-600 hover:bg-blue-600/90 text-white'
                  : 'bg-primary hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed text-primary-foreground'
            }`}
            title={isContextCritical || willExceed ? 'Send blocked: context exceeded' : showStop ? `Queue message (${submitKs})` : `Send (${submitKs})`}
          >
            {isContextCritical || willExceed ? 'Blocked' : 'Send'}
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
