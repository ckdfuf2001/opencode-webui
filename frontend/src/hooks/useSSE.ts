import { useEffect, useRef, useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useOpenCodeClient } from './useOpenCode'
import type { SSEEvent, MessageListResponse, MessageWithParts, QuestionRequest, PermissionAskedProps } from '@/api/types'
import { permissionEvents } from './usePermissionRequests'
import { questionEvents } from './useQuestionRequests'
import { sessionActivityEvents } from './useSessionActivity'
import { showToast } from '@/lib/toast'
import { settingsApi } from '@/api/settings'

const MAX_RECONNECT_DELAY = 30000
const INITIAL_RECONNECT_DELAY = 1000

const SESSION_ERROR_MESSAGES: Record<string, string> = {
  ProviderAuthError: 'Provider authentication failed. Check your API key.',
  UnknownError: 'An unexpected error occurred.',
  MessageOutputLengthError: 'The model output exceeded the maximum allowed length.',
  MessageAbortedError: 'The message was aborted.',
  APIError: 'The model API returned an error.',
}

function getSessionErrorMessage(error: { name: string; data: Record<string, unknown> } | undefined): string {
  if (!error) return 'A session error occurred.'
  const detail = error.data?.message
  if (typeof detail === 'string' && detail.length > 0) return detail
  return SESSION_ERROR_MESSAGES[error.name] ?? error.name
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
          queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', opcodeUrl, activeDirectory] })
          if ('info' in event.properties) {
            queryClient.invalidateQueries({ 
              queryKey: ['opencode', 'session', opcodeUrl, event.properties.info.id, activeDirectory] 
            })
          }
          break

        case 'session.deleted':
          queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', opcodeUrl, activeDirectory] })
          if ('sessionID' in event.properties) {
            queryClient.invalidateQueries({ 
              queryKey: ['opencode', 'session', opcodeUrl, event.properties.sessionID, activeDirectory] 
            })
            sessionActivityEvents.emit({ type: 'remove', sessionID: event.properties.sessionID })
          }
          break

        case 'session.created':
          queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', opcodeUrl, activeDirectory] })
          break

        case 'session.idle': {
          if (!('sessionID' in event.properties)) break

          const { sessionID } = event.properties
          sessionActivityEvents.emit({ type: 'idle', sessionID })
          queryClient.invalidateQueries({ queryKey: ['opencode', 'session', opcodeUrl, sessionID, activeDirectory] })
          queryClient.invalidateQueries({ queryKey: ['opencode', 'messages', opcodeUrl, sessionID, activeDirectory] })
          break
        }

        case 'session.error': {
          const message = getSessionErrorMessage(event.properties.error)
          showToast.error(message, { duration: 8000 })
          if (event.properties.sessionID) {
            sessionActivityEvents.emit({ type: 'idle', sessionID: event.properties.sessionID })
            queryClient.invalidateQueries({ 
              queryKey: ['opencode', 'session', opcodeUrl, event.properties.sessionID, activeDirectory] 
            })
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
          
          const currentData = queryClient.getQueryData<MessageListResponse>(['opencode', 'messages', opcodeUrl, sessionID, activeDirectory])
          if (!currentData) return
          
          const messageExists = currentData.some(msg => msg.info.id === messageID)
          if (!messageExists) return
          
          const updated = currentData.map(msg => {
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
          
          queryClient.setQueryData(['opencode', 'messages', opcodeUrl, sessionID, activeDirectory], updated)
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
          
          const currentData = queryClient.getQueryData<MessageListResponse>(['opencode', 'messages', opcodeUrl, sessionID, activeDirectory])
          if (!currentData) {
            queryClient.setQueryData(['opencode', 'messages', opcodeUrl, sessionID, activeDirectory], [{ info, parts: [] }])
            return
          }
          
          const messageExists = currentData.some(msg => msg.info.id === info.id)
          
          if (!messageExists) {
            const filteredData = info.role === 'user' 
              ? currentData.filter(msg => !msg.info.id.startsWith('optimistic_'))
              : currentData
            queryClient.setQueryData(['opencode', 'messages', opcodeUrl, sessionID, activeDirectory], [...filteredData, { info, parts: [] }])
            return
          }
          
          const updated = currentData.map(msg => {
            if (msg.info.id !== info.id) return msg
            return { 
              info: { ...info }, 
              parts: [...msg.parts] 
            }
          })
          
          queryClient.setQueryData(['opencode', 'messages', opcodeUrl, sessionID, activeDirectory], updated)
          break
        }

        case 'message.removed':
        case 'messagev2.removed': {
          if (!('sessionID' in event.properties && 'messageID' in event.properties)) break
          
          const { sessionID, messageID } = event.properties
          
          queryClient.setQueryData<MessageListResponse>(
            ['opencode', 'messages', opcodeUrl, sessionID, activeDirectory],
            (old) => {
              if (!old) return old
              return old.filter(msg => msg.info.id !== messageID)
            }
          )
          break
        }

        case 'message.part.removed':
        case 'messagev2.part.removed': {
          if (!('sessionID' in event.properties && 'messageID' in event.properties && 'partID' in event.properties)) break
          
          const { sessionID, messageID, partID } = event.properties
          
          queryClient.setQueryData<MessageListResponse>(
            ['opencode', 'messages', opcodeUrl, sessionID, activeDirectory],
            (old) => {
              if (!old) return old
              
              return old.map(msg => {
                if (msg.info.id !== messageID) return msg
                return {
                  ...msg,
                  parts: msg.parts.filter(p => p.id !== partID)
                }
              })
            }
          )
          break
        }

        case 'session.compacted': {
          if (!('sessionID' in event.properties)) break
          
          const { sessionID } = event.properties
          queryClient.invalidateQueries({ 
            queryKey: ['opencode', 'messages', opcodeUrl, sessionID, activeDirectory] 
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
              queryKey: ['opencode', 'todos', opcodeUrl, event.properties.sessionID, activeDirectory] 
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
        case 'file.watcher.updated':
          queryClient.invalidateQueries({ queryKey: ['file'] })
          break

        case 'command.executed': {
          const { name, sessionID } = event.properties
          showToast.info(`Command "${name}" executed`, { duration: 3000 })
          queryClient.invalidateQueries({ queryKey: ['opencode', 'messages', opcodeUrl, sessionID, activeDirectory] })
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
          toastFn(title ? `${title}: ${message}` : message, { duration: duration || 5000 })
          break
        }

        case 'tui.prompt.append':
        case 'tui.command.execute':
          break

        case 'server.connected':
          queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', opcodeUrl, activeDirectory] })
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
          const wasConnected = wasConnectedRef.current
          setIsConnected(true)
          setError(null)
          resetReconnectDelay()
          queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', opcodeUrl, directory] })
          queryClient.invalidateQueries({ queryKey: ['opencode', 'messages', opcodeUrl] })

          if (wasConnected) {
            const allQueries = queryClient.getQueryCache().getAll()
            for (const query of allQueries) {
              const key = query.queryKey
              if (key[0] === 'opencode' && key[1] === 'messages') {
                const data = query.state.data as MessageWithParts[] | undefined
                if (!data) continue
                let changed = false
                const updated = data.map(msg => {
                  if (msg.info.role !== 'assistant') return msg
                  if ('completed' in msg.info.time && msg.info.time.completed) return msg
                  changed = true
                  return { ...msg, info: { ...msg.info, time: { ...msg.info.time, completed: Date.now() } } }
                })
                if (changed) {
                  queryClient.setQueryData(key, updated)
                }
              }
            }
            showToast.info('Reconnected — stale streams marked as completed', { duration: 3000 })
          }
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
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
        setIsConnected(false)
      }
    }
  }, [client, queryClient, opcodeUrl, directory, global, scheduleReconnect, resetReconnectDelay])

  return { isConnected, error, isReconnecting }
}
