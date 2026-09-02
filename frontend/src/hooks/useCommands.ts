import { useState, useEffect, useCallback, useRef } from 'react'
import { createOpenCodeClient } from '@/api/opencode'
import type { components } from '@/api/opencode-types'

export type CommandScope = 'builtin' | 'global' | 'project'

export type CommandWithScope = components['schemas']['Command'] & {
  scope?: CommandScope
  source?: string
  // Declarative built-in commands (e.g. /help, /models) return immediately
  // without producing a streamed assistant response.
  oneshot?: boolean
}

// Built-in OpenCode commands
const BUILTIN_COMMANDS: CommandWithScope[] = [
  {
    name: 'help',
    description: 'Show the help dialog',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'init',
    description: 'Create or update AGENTS.md file',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'new',
    description: 'Start a new session',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'clear',
    description: 'Start a new session (alias for /new)',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'sessions',
    description: 'List and switch between sessions',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'resume',
    description: 'List and switch between sessions (alias for /sessions)',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'continue',
    description: 'List and switch between sessions (alias for /sessions)',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'models',
    description: 'List available models',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'themes',
    description: 'List available themes',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'share',
    description: 'Share current session',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'unshare',
    description: 'Unshare current session',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'export',
    description: 'Export current conversation to Markdown',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'compact',
    description: 'Compact the current session',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'summarize',
    description: 'Compact the current session (alias for /compact)',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'undo',
    description: 'Undo last message in the conversation',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'redo',
    description: 'Redo a previously undone message',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'details',
    description: 'Toggle tool execution details',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin',
    oneshot: true
  },
  {
    name: 'editor',
    description: 'Open external editor for composing messages',
    template: '',
    agent: '',
    model: '',
    subtask: false,
    scope: 'builtin'
  }
]

const COMMANDS_FETCH_TIMEOUT_MS = 12000
const FETCH_RETRY_DELAY_MS = 5000
const FETCH_RETRY_MAX = 3
const commandsCache = new Map<string, CommandWithScope[]>()
// cacheKey 별 마지막 성공 시각. 전역 하나로 쓰면 다른 인스턴스의 성공 직후에
// 갱신을 건너뛰어 방금 등록한 커맨드/스킬이 슬래시 메뉴에 안 보였다.
const lastSuccessfulFetchByKey = new Map<string, number>()
let inFlight: { key: string; token: { done: boolean }; promise: Promise<void> } | null = null

export function useCommands(opcodeUrl: string | null, directory?: string) {
  const [commands, setCommands] = useState<CommandWithScope[]>(BUILTIN_COMMANDS)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastAttemptSucceededRef = useRef(true)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryCountRef = useRef(0)

  const cacheKey = `${opcodeUrl ?? ''}|${directory ?? ''}`

  const fetchCommands = useCallback(async () => {
    if (inFlight && inFlight.key === cacheKey) return inFlight.promise
    setLoading(true)

    const base = [...BUILTIN_COMMANDS]
    const token = { done: false }

    const promise = (async () => {
      try {
        let openCodeCommands: CommandWithScope[] = []
        if (opcodeUrl) {
          const client = createOpenCodeClient(opcodeUrl, directory)
          openCodeCommands = (await client.listCommands(COMMANDS_FETCH_TIMEOUT_MS)) as CommandWithScope[]
        }

        const merged = [...base, ...openCodeCommands]
        const unique = merged.filter((command, index, self) =>
          index === self.findIndex((c) => c.name === command.name)
        )
        commandsCache.set(cacheKey, unique)
        setCommands(unique)
        setError(null)
        lastAttemptSucceededRef.current = true
        lastSuccessfulFetchByKey.set(cacheKey, Date.now())
        retryCountRef.current = 0
      } catch (err) {
        const cached = commandsCache.get(cacheKey)
        if (cached && cached.length > base.length) {
          setCommands(cached)
          setError(null)
          if (lastAttemptSucceededRef.current) {
            lastAttemptSucceededRef.current = false
            console.warn('Commands fetch failed (server busy?); serving cached list until it recovers')
          }
        } else {
          console.error('Failed to fetch commands:', err)
          setError('Failed to load commands')
          setCommands(base)
        }
        // 마운트 시 1회만 받고 끝나면, 서버가 바쁜 동안 만든 커맨드/스킬을 영원히 못 받는다.
        // 실패 시에는 백오프 재시도를 건다.
        if (opcodeUrl && retryCountRef.current < FETCH_RETRY_MAX) {
          retryCountRef.current += 1
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
          retryTimerRef.current = setTimeout(() => { void fetchCommands() }, FETCH_RETRY_DELAY_MS)
        }
      } finally {
        token.done = true
        setLoading(false)
        if (inFlight && inFlight.token === token) inFlight = null
      }
    })()

    inFlight = { key: cacheKey, token, promise }
    return promise
  }, [opcodeUrl, directory, cacheKey])

  useEffect(() => {
    fetchCommands()
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [fetchCommands])

  // 다른 인스턴스(커맨드 패널 refresh 등)가 목록을 새로 받으면 즉시 재조회한다.
  // 기존에는 캐시만 채택해 다른 directory의 커맨드가 안 보였고, 스킬(registry-list)과 달리 커맨드는 opencode 서버 재조회가 필요했다.
  useEffect(() => {
    const handler = () => {
      retryCountRef.current = 0
      void fetchCommands()
    }
    window.addEventListener('opencode:commands-refreshed', handler)
    return () => window.removeEventListener('opencode:commands-refreshed', handler)
  }, [cacheKey, fetchCommands])

  const refresh = useCallback(() => {
    retryCountRef.current = 0
    if (inFlight && inFlight.key === cacheKey) inFlight = null
    void fetchCommands()
  }, [fetchCommands, cacheKey])

  /** 입력창 포커스·슬래시 메뉴 오픈에서 호출: 이 디렉터리 목록이 오래됐으면 새로 받는다. */
  const refreshIfStale = useCallback((maxAgeMs = 30_000) => {
    if (!opcodeUrl) return
    const last = lastSuccessfulFetchByKey.get(cacheKey) ?? 0
    if (Date.now() - last > maxAgeMs) {
      retryCountRef.current = 0
      if (inFlight && inFlight.key === cacheKey) inFlight = null
      void fetchCommands()
    }
  }, [opcodeUrl, cacheKey, fetchCommands])

  const removeCustomCommand = useCallback((name: string) => {
    setCommands((prev) => prev.filter((c) => c.name !== name))
  }, [])

  const filterCommands = (query: string) => {
    if (!query.trim()) return commands

    const searchTerm = query.toLowerCase()
    // 이름 매칭을 먼저, 설명(내용) 매칭은 그 다음 순으로 보여준다.
    const rank = (command: CommandWithScope): number => {
      const name = command.name.toLowerCase()
      if (name.startsWith(searchTerm)) return 0
      if (name.includes(searchTerm)) return 1
      return 2
    }
    return commands
      .filter(command =>
        command.name.toLowerCase().includes(searchTerm) ||
        command.description?.toLowerCase().includes(searchTerm)
      )
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }

  return {
    commands,
    loading,
    error,
    filterCommands,
    refresh,
    refreshIfStale,
    removeCustomCommand
  }
}