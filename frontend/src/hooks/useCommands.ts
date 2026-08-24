import { useState, useEffect, useCallback } from 'react'
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

export function useCommands(opcodeUrl: string | null, directory?: string) {
  const [commands, setCommands] = useState<CommandWithScope[]>(BUILTIN_COMMANDS)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchCommands = useCallback(async () => {
    setLoading(true)
    setError(null)

    const base = [...BUILTIN_COMMANDS]

    try {
      let openCodeCommands: CommandWithScope[] = []
      if (opcodeUrl) {
        const client = createOpenCodeClient(opcodeUrl, directory)
        openCodeCommands = (await client.listCommands()) as CommandWithScope[]
      }

      const merged = [...base, ...openCodeCommands]
      const unique = merged.filter((command, index, self) =>
        index === self.findIndex((c) => c.name === command.name)
      )
      setCommands(unique)
    } catch (err) {
      console.error('Failed to fetch commands:', err)
      setError('Failed to load commands')
      // 서버가 바쁠 때 실패해도 마지막 목록을 유지한다(builtin으로 덮어쓰지 않음).
      // 최초 로드 실패 시에만 builtin으로 시작한다.
      setCommands((prev) => (prev.length > base.length ? prev : base))
    } finally {
      setLoading(false)
    }
  }, [opcodeUrl, directory])

  useEffect(() => {
    fetchCommands()
  }, [fetchCommands])

  const refresh = useCallback(() => {
    fetchCommands()
  }, [fetchCommands])

  const removeCustomCommand = useCallback((name: string) => {
    setCommands((prev) => prev.filter((c) => c.name !== name))
  }, [])

  const filterCommands = (query: string) => {
    if (!query.trim()) return commands
    
    const searchTerm = query.toLowerCase()
    return commands.filter(command =>
      command.name.toLowerCase().includes(searchTerm) ||
      command.description?.toLowerCase().includes(searchTerm)
    )
  }

  return {
    commands,
    loading,
    error,
    filterCommands,
    refresh,
    removeCustomCommand
  }
}