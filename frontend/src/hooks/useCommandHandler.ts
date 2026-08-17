import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { createOpenCodeClient } from '@/api/opencode'
import { useCreateSession } from '@/hooks/useOpenCode'
import { useCommands } from '@/hooks/useCommands'
import { useCommandRuns } from '@/stores/commandRunsStore'
import { showToast } from '@/lib/toast'
import type { components } from '@/api/opencode-types'

type CommandType = components['schemas']['Command']

interface CommandHandlerProps {
  opcodeUrl: string
  sessionID: string
  directory?: string
  onShowSessionsDialog?: () => void
  onShowModelsDialog?: () => void
  onShowHelpDialog?: () => void
}

// Commands that exist on the opencode server (v1.18.11)
const SERVER_COMMANDS = new Set(['init', 'review'])

export function useCommandHandler({
  opcodeUrl,
  sessionID,
  directory,
  onShowSessionsDialog,
  onShowModelsDialog,
  onShowHelpDialog
}: CommandHandlerProps) {
  const navigate = useNavigate()
  const createSession = useCreateSession(opcodeUrl, directory)
  const { commands } = useCommands(opcodeUrl, directory)
  const [loading, setLoading] = useState(false)

  const executeCommand = useCallback(async (command: CommandType, explicitArgs?: string) => {
    if (!opcodeUrl) return

    setLoading(true)
    const args = explicitArgs ?? ''
    useCommandRuns.getState().startRun(sessionID, command.name, args, directory)

    try {
      const client = createOpenCodeClient(opcodeUrl, directory)
      
      // Check if command exists on server (built-in + MCP + skills from fetched list)
      const serverCommandNames = new Set([
        ...SERVER_COMMANDS,
        ...(commands?.map((c: typeof commands[0]) => c.name) ?? [])
      ])
      const isServerCommand = serverCommandNames.has(command.name)

      // Handle special commands that need UI interaction
      switch (command.name) {
        case 'sessions':
        case 'resume':
        case 'continue':
          onShowSessionsDialog?.()
          break
          
        case 'models':
          onShowModelsDialog?.()
          break
          
        case 'themes':
          showToast.warning(
            `"/${command.name}" is not supported in the web UI. This command runs only in the terminal (TUI).`
          )
          break
          
        case 'help':
          onShowHelpDialog?.()
          break
          
        case 'new':
        case 'clear':
          // Create a new session and navigate to it
          try {
            const newSession = await createSession.mutateAsync({
              agent: undefined
            })
            if (newSession?.id) {
              const currentPath = window.location.pathname
              const repoMatch = currentPath.match(/\/repos\/(\d+)\/sessions\//)
              if (repoMatch) {
                const repoId = repoMatch[1]
                const newPath = `/repos/${repoId}/sessions/${newSession.id}`
                navigate(newPath)
              } else {
                navigate(`/session/${newSession.id}`)
              }
            }
          } catch (error) {
            console.error('Failed to create new session:', error)
          }
          break
          
        case 'share':
        case 'unshare':
        case 'export':
        case 'compact':
        case 'summarize':
        case 'undo':
        case 'redo':
        case 'details':
        case 'editor':
          // TUI-only commands that the web HTTP API cannot execute
          showToast.warning(
            `"/${command.name}" is not supported in the web UI. This command runs only in the terminal (TUI).`
          )
          break
          
        default:
          // Only send commands that exist on the server
          if (isServerCommand) {
            await client.sendCommand(sessionID, {
              command: command.name,
              arguments: args
            })
          } else {
            showToast.warning(
              `Unknown command: "/${command.name}". Available: ${[...serverCommandNames].join(', ')}`
            )
          }
      }
    } catch (error) {
      console.error('Failed to execute command:', error)
    } finally {
      setLoading(false)
    }
  }, [sessionID, opcodeUrl, onShowSessionsDialog, onShowModelsDialog, onShowHelpDialog, createSession, navigate, commands, directory])

  return {
    executeCommand,
    loading
  }
}