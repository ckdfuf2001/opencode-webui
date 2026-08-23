import { useEffect, useRef, useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useOpenCodeClient } from './useOpenCode'
import type { SSEEvent, MessageListResponse, QuestionRequest, PermissionAskedProps } from '@/api/types'
import { permissionEvents } from './usePermissionRequests'
import { questionEvents } from './useQuestionRequests'
import { sessionActivityEvents } from './useSessionActivity'
import { showToast } from '@/lib/toast'
import { settingsApi } from '@/api/settings'
import { listCommandRunsBySession, finishCommandRun } from '@/api/command-runs'

const MAX_RECONNECT_DELAY = 30000
const INITIAL_RECONNECT_DELAY = 1000

const SESSION_ERROR_MESSAGES: Record<string, string> = {
  ProviderAuthError: 'Provider authentication failed. Check your API key.',
  UnknownError: 'An unexpected error occurred.',
  MessageOutputLengthError: 'The model output exceeded the maximum allowed length.',
  MessageAbortedError: 'The message was aborted.',
  APIError: 'The model API returned an error.',
  RateLimitError: 'Rate limit exceeded. Please wait before sending more requests.',
  QuotaExceededError: 'Usage quota exceeded. Check your provider limits.',
}

function getSessionErrorMessage(error: { name: string; data: Record<string, unknown> } | undefined): string {
  if (!error) return 'A session error occurred.'
  const detail = error.data?.message
  if (typeof detail === 'string' && detail.length > 0) return detail
  return SESSION_ERROR_MESSAGES[error.name] ?? error.name
}

const RUN_FAILURE_WINDOW_MS = 10 * 60 * 1000

// Message caches are keyed per directory variant; SSE events must update every
// variant or the UI keeps stale state (e.g. a finished command stuck on
// "running" because time.completed landed in a differently-keyed cache entry).
function updateMessagesQueries(
  queryClient: QueryClient,
  opcodeUrl: string | null | undefined,
  sessionID: string,
  updater: (data: MessageListResponse) => MessageListResponse,
): boolean {
  const queries = queryClient.getQueryCache().findAll({ queryKey: ['opencode', 'messages', opcodeUrl, sessionID] })
  let touched = false
  for (const query of queries) {
    const data = query.state.data as MessageListResponse | undefined
    if (!data) continue
    queryClient.setQueryData(query.queryKey, updater(data))
    touched = true
  }
  return touched
}

async function markLatestSessionRunFinished(
  queryClient: QueryClient,
  sessionID: string,
  status: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  try {
    const runs = await listCommandRunsBySession(sessionID)
    if (runs.length === 0) return
    const latest = [...runs].sort((a, b) => b.startedAt - a.startedAt)[0]
    // 아직 진행 중('started')인 최근 실행만 마킹한다. 종료된 기록은 건드리지 않는다.
    if (latest.status !== 'started') return
    const recent = Date.now() - latest.startedAt < RUN_FAILURE_WINDOW_MS
    if (!recent) return
    await finishCommandRun(latest.id, status)
    queryClient.invalidateQueries({ queryKey: ['command-runs'] })
  } catch {
    // best-effort history update
  }
}

const handleRestartServer = async () => {
  showToast.loading('Restarting OpenCode server...', {
    id: 'restart-server',
  })
  
  try {
    const result = await settingsApi.restartOpenCodeServer()
    if (result.success) {
      showToast.success(result.message || 'OpenCode server restarted successfully', {
        id: 'restart-server',
        duration: 3000,
      })
      setTimeout(() => {
        window.location.reload()
      }, 2000)
    } else {
      showToast.error(result.message || 'Failed to restart OpenCode server', {
        id: 'restart-server',
        duration: 5000,
      })
    }
  } catch (error) {
    showToast.error(error instanceof Error ? error.message : 'Failed to restart OpenCode server', {
      id: 'restart-server',
      duration: 5000,
    })
  }
}


export const useSSE = (opcodeUrl: string | null | undefined, directory?: string, global?: boolean) => {
  const client = useOpenCodeClient(opcodeUrl, directory)
  const queryClient = useQueryClient()
  const eventSourceRef = useRef<EventSource | null>(null)
  const urlRef = useRef<string | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInvalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY)
  const mountedRef = useRef(true)
  const wasConnectedRef = useRef(false)
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isReconnecting, setIsReconnecting] = useState(false)

  const scheduleReconnect = useCallback((connectFn: () => void) => {
    if (!mountedRef.current) return
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
    }
    
    const delay = reconnectDelayRef.current
    setIsReconnecting(true)
    
    reconnectTimeoutRef.current = setTimeout(() => {
      if (!mountedRef.current) return
      reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY)
      connectFn()
    }, delay)
  }, [])

  const resetReconnectDelay = useCallback(() => {
    reconnectDelayRef.current = INITIAL_RECONNECT_DELAY
    setIsReconnecting(false)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    
    if (!client) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
        urlRef.current = null
        setIsConnected(false)
      }
      return
    }

    const eventSourceUrl = global ? client.getGlobalEventSourceURL() : client.getEventSourceURL()
    
    if (urlRef.current === eventSourceUrl && eventSourceRef.current) {
      return
    }
    
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
    }
    
    urlRef.current = eventSourceUrl

    const handleSSEEvent = (event: SSEEvent, eventDirectory?: string) => {
      const activeDirectory = global ? (eventDirectory ?? directory) : directory
      switch (event.type) {
        case 'session.updated':
          queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', opcodeUrl] })
          if ('info' in event.properties) {
            queryClient.invalidateQueries({
              queryKey: ['opencode', 'session', opcodeUrl, event.properties.info.id]
            })
          }
          break

        case 'session.deleted':
          queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', opcodeUrl] })
          if ('sessionID' in event.properties) {
            queryClient.invalidateQueries({
              queryKey: ['opencode', 'session', opcodeUrl, event.properties.sessionID]
            })
            sessionActivityEvents.emit({ type: 'remove', sessionID: event.properties.sessionID })
          }
          break

        case 'session.created':
          queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', opcodeUrl] })
          break

        case 'session.idle': {
          if (!('sessionID' in event.properties)) break

          const { sessionID } = event.properties
          sessionActivityEvents.emit({ type: 'idle', sessionID })
          queryClient.invalidateQueries({ queryKey: ['opencode', 'session', opcodeUrl, sessionID] })
          queryClient.invalidateQueries({ queryKey: ['opencode', 'messages', opcodeUrl, sessionID] })
          // 응답 완료 = 커맨드 히스토리 갱신 시점. 진행 중 run을 completed로 마킹하고
          // 패널/캘린더가 파일 이력의 최신 상태를 바로 받아오게 한다.
          void markLatestSessionRunFinished(queryClient, sessionID, 'completed')
          queryClient.invalidateQueries({ queryKey: ['command-runs'] })
          break
        }

        case 'session.error': {
          const sessionID = event.properties.sessionID
          const isAbort = event.properties.error?.name === 'MessageAbortedError'
          const message = getSessionErrorMessage(event.properties.error)
          showToast.error(message, { duration: 8000, id: `session-error-${sessionID ?? 'unknown'}` })
          if (sessionID) {
            sessionActivityEvents.emit({ type: 'idle', sessionID })
            queryClient.invalidateQueries({
              queryKey: ['opencode', 'session', opcodeUrl, sessionID]
            })
            void markLatestSessionRunFinished(queryClient, sessionID, isAbort ? 'cancelled' : 'failed')
          }
          break
        }

        case 'message.part.updated':
        case 'messagev2.part.updated': {
          if (!('part' in event.properties)) break
          
          const { part } = event.properties
          const sessionID = part.sessionID
          const messageID = part.messageID
          sessionActivityEvents.emit({ type: 'active', sessionID })
          
          updateMessagesQueries(queryClient, opcodeUrl, sessionID, (currentData) => {
            const messageExists = currentData.some(msg => msg.info.id === messageID)
            if (!messageExists) return currentData
            
            return currentData.map(msg => {
              if (msg.info.id !== messageID) return msg
              
              const existingPartIndex = msg.parts.findIndex(p => p.id === part.id)
              
              if (existingPartIndex >= 0) {
                const newParts = [...msg.parts]
                newParts[existingPartIndex] = { ...part }
                return { 
                  info: { ...msg.info }, 
                  parts: newParts 
                }
              } else {
                return { 
                  info: { ...msg.info }, 
                  parts: [...msg.parts, { ...part }] 
                }
              }
            })
          })
          break
        }

        case 'message.updated':
        case 'messagev2.updated': {
          if (!('info' in event.properties)) break
          
          const { info } = event.properties
          const sessionID = info.sessionID
          if (info.role === 'assistant' && info.time.completed) {
            sessionActivityEvents.emit({ type: 'completing', sessionID })
          } else {
            sessionActivityEvents.emit({ type: 'active', sessionID })
          }
          
          const updated = updateMessagesQueries(queryClient, opcodeUrl, sessionID, (currentData) => {
            const messageExists = currentData.some(msg => msg.info.id === info.id)
            
            if (!messageExists) {
              const filteredData = info.role === 'user' 
                ? currentData.filter(msg => !msg.info.id.startsWith('optimistic_'))
                : currentData
              return [...filteredData, { info, parts: [] }]
            }
            
            return currentData.map(msg => {
              if (msg.info.id !== info.id) return msg
              return { 
                info: { ...info }, 
                parts: [...msg.parts] 
              }
            })
          })
          
          if (!updated) {
            queryClient.setQueryData(['opencode', 'messages', opcodeUrl, sessionID, activeDirectory], [{ info, parts: [] }])
          }
          break
        }

        case 'message.removed':
        case 'messagev2.removed': {
          if (!('sessionID' in event.properties && 'messageID' in event.properties)) break
          
          const { sessionID, messageID } = event.properties
          
          updateMessagesQueries(queryClient, opcodeUrl, sessionID, (old) =>
            old.filter(msg => msg.info.id !== messageID)
          )
          break
        }

        case 'message.part.removed':
        case 'messagev2.part.removed': {
          if (!('sessionID' in event.properties && 'messageID' in event.properties && 'partID' in event.properties)) break
          
          const { sessionID, messageID, partID } = event.properties
          
          updateMessagesQueries(queryClient, opcodeUrl, sessionID, (old) =>
            old.map(msg => {
              if (msg.info.id !== messageID) return msg
              return {
                ...msg,
                parts: msg.parts.filter(p => p.id !== partID)
              }
            })
          )
          break
        }

        case 'session.compacted': {
          if (!('sessionID' in event.properties)) break
          
          const { sessionID } = event.properties
          queryClient.invalidateQueries({ 
            queryKey: ['opencode', 'messages', opcodeUrl, sessionID] 
          })
          break
        }

        case 'permission.asked':
        case 'permission.updated': {
          if ('id' in event.properties) {
            const props = event.properties as PermissionAskedProps
            const rawPatterns = props.patterns ?? props.pattern
            const patterns = Array.isArray(rawPatterns) ? rawPatterns : rawPatterns ? [rawPatterns] : []
            const type = props.permission ?? props.type ?? 'permission'
            permissionEvents.emit({
              type: 'add',
              permission: {
                id: props.id,
                sessionID: props.sessionID,
                type,
                permission: props.permission,
                pattern: patterns,
                patterns,
                always: props.always,
                metadata: props.metadata ?? {},
                title: props.title ?? `Allow ${type}?`,
                messageID: props.tool?.messageID ?? '',
                callID: props.tool?.callID,
                tool: props.tool,
                time: props.time ?? { created: Date.now() },
                directory: eventDirectory,
              },
            })
          }
          break
        }

        case 'permission.v2.asked': {
          const props = event.properties as {
            id: string
            sessionID: string
            action: string
            resources?: string[]
            save?: string[]
            metadata?: Record<string, unknown>
            source?: { type: string; messageID?: string; callID?: string }
          }
          const patterns = props.resources ?? []
          const type = props.action ?? 'permission'
          const tool = props.source?.type === 'tool' && props.source
            ? { messageID: props.source.messageID ?? '', callID: props.source.callID }
            : undefined
          permissionEvents.emit({
            type: 'add',
            permission: {
              id: props.id,
              sessionID: props.sessionID,
              type,
              permission: props.action,
              pattern: patterns,
              patterns,
              always: props.save,
              metadata: props.metadata ?? {},
              title: `Allow ${type}?`,
              messageID: tool?.messageID ?? '',
              callID: tool?.callID,
              tool,
              time: { created: Date.now() },
              v2: true,
              directory: eventDirectory,
            },
          })
          break
        }

        case 'permission.replied': {
          const props = event.properties as { requestID?: string; permissionID?: string }
          const requestID = props.requestID ?? props.permissionID
          if (requestID) {
            permissionEvents.emit({ type: 'remove', permissionID: requestID })
          }
          break
        }

        case 'permission.v2.replied': {
          const props = event.properties as { requestID?: string; permissionID?: string }
          const requestID = props.requestID ?? props.permissionID
          if (requestID) {
            permissionEvents.emit({ type: 'remove', permissionID: requestID })
          }
          break
        }

        case 'question.asked':
        case 'question.v2.asked': {
          const props = event.properties as QuestionRequest
          if ('id' in props && 'questions' in props) {
            questionEvents.emit({ type: 'add', question: props })
          }
          break
        }

        case 'question.replied':
        case 'question.v2.replied': {
          const props = event.properties as unknown as { requestID?: string }
          if (props.requestID) {
            questionEvents.emit({ type: 'remove', requestID: props.requestID })
          }
          break
        }

        case 'question.rejected':
        case 'question.v2.rejected': {
          const props = event.properties as unknown as { requestID?: string }
          if (props.requestID) {
            questionEvents.emit({ type: 'remove', requestID: props.requestID })
          }
          break
        }

        case 'todo.updated':
          if ('sessionID' in event.properties) {
            queryClient.invalidateQueries({ 
              queryKey: ['opencode', 'todos', opcodeUrl, event.properties.sessionID] 
            })
          }
          break

        case 'installation.updated':
          if ('version' in event.properties) {
            showToast.success(`OpenCode updated to v${event.properties.version}`, {
              description: 'The server has been successfully upgraded.',
              duration: 5000,
            })
          }
          break

        case 'installation.update-available':
          if ('version' in event.properties) {
            showToast.info(`OpenCode v${event.properties.version} is available`, {
              description: 'A new version is ready to install.',
              action: {
                label: 'Restart to Update',
                onClick: handleRestartServer
              },
              duration: 10000,
            })
          }
          break

        case 'file.edited':
        case 'file.watcher.updated': {
          if (fileInvalidateTimerRef.current) {
            clearTimeout(fileInvalidateTimerRef.current)
          }
          fileInvalidateTimerRef.current = setTimeout(() => {
            fileInvalidateTimerRef.current = null
            queryClient.invalidateQueries({ queryKey: ['file'] })
            queryClient.invalidateQueries({ queryKey: ['files'] })
          }, 500)
          break
        }

        case 'command.executed': {
          const { name, sessionID } = event.properties
          showToast.info(`Command "${name}" executed`, { duration: 3000 })
          queryClient.invalidateQueries({ queryKey: ['opencode', 'messages', opcodeUrl, sessionID] })
          break
        }

        case 'lsp.client.diagnostics': {
          const { path } = event.properties
          showToast.warning(`Diagnostics available for ${path}`, { duration: 5000 })
          break
        }

        case 'lsp.updated':
          break

        case 'tui.toast.show': {
          const { title, message, variant, duration } = event.properties
          const toastFn = variant === 'success'
            ? showToast.success
            : variant === 'error'
              ? showToast.error
              : variant === 'warning'
                ? showToast.warning
                : showToast.info
          toastFn(title ? `${title}: ${message}` : message, { duration: duration || 5000, id: `tui-toast-${title ?? 'toast'}-${message}` })
          break
        }

        case 'tui.prompt.append':
        case 'tui.command.execute':
          break

        case 'server.connected':
          queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', opcodeUrl] })
          break

        default:
          break
      }
    }
    
    const connectSSE = () => {
      if (!mountedRef.current) return
      
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }

      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }

      try {
        const eventSource = new EventSource(eventSourceUrl)
        eventSourceRef.current = eventSource

        eventSource.onopen = () => {
          if (!mountedRef.current) return
          setIsConnected(true)
          setError(null)
          resetReconnectDelay()
          queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', opcodeUrl] })
          queryClient.invalidateQueries({ queryKey: ['opencode', 'messages', opcodeUrl] })
          wasConnectedRef.current = true
        }

        eventSource.onerror = () => {
          if (!mountedRef.current) return

          setIsConnected(false)
          setError('Connection lost. Reconnecting...')

          if (eventSourceRef.current) {
            eventSourceRef.current.close()
            eventSourceRef.current = null
          }

          scheduleReconnect(connectSSE)
        }

        eventSource.onmessage = (event) => {
          try {
            const raw: unknown = JSON.parse(event.data)
            const wrapped = global && raw && typeof raw === 'object' && 'payload' in raw
              ? raw as { payload: { type: string }; directory?: string }
              : undefined
            if (wrapped?.payload.type === 'sync') return
            const data = wrapped ? wrapped.payload as SSEEvent : raw as SSEEvent
            const eventDirectory = wrapped?.directory
            handleSSEEvent(data, eventDirectory)
          } catch (err) {
            console.error('Failed to parse SSE event:', err)
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to connect')
        setIsConnected(false)
        scheduleReconnect(connectSSE)
      }
    }

    const handleReconnect = () => {
      if (!eventSourceRef.current || eventSourceRef.current.readyState === EventSource.CLOSED) {
        resetReconnectDelay()
        connectSSE()
      }
    }

    connectSSE()

    window.addEventListener('focus', handleReconnect)
    window.addEventListener('online', handleReconnect)

    return () => {
      mountedRef.current = false
      window.removeEventListener('focus', handleReconnect)
      window.removeEventListener('online', handleReconnect)
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
      if (fileInvalidateTimerRef.current) {
        clearTimeout(fileInvalidateTimerRef.current)
        fileInvalidateTimerRef.current = null
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
        setIsConnected(false)
      }
    }
  }, [client, queryClient, opcodeUrl, directory, global, scheduleReconnect, resetReconnectDelay])

  return { isConnected, error, isReconnecting }
}
