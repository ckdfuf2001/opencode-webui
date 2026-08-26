import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { createOpenCodeClient } from '@/api/opencode'
import { useCreateSession } from '@/hooks/useOpenCode'
import type { CommandWithScope } from '@/hooks/useCommands'
import { useCreateCommandRun, useFinishCommandRun } from '@/hooks/useCommandRuns'
import { showToast } from '@/lib/toast'
import type { components } from '@/api/opencode-types'

type CommandType = components['schemas']['Command']

interface CommandHandlerProps {
  opcodeUrl: string
  sessionID: string
  directory?: string
  repoId?: number
  /** 드롭다운과 같은 목록을 공유한다. 별도 fetch 인스턴스를 두면 목록이 어긋나 실행이 차단된다. */
  commands: CommandWithScope[]
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
  repoId,
  commands,
  onShowSessionsDialog,
  onShowModelsDialog,
  onShowHelpDialog
}: CommandHandlerProps) {
  const navigate = useNavigate()
  const createSession = useCreateSession(opcodeUrl, directory)
  const [loading, setLoading] = useState(false)

  const createRun = useCreateCommandRun()
  const finishRun = useFinishCommandRun()

  const executeCommand = useCallback(async (command: CommandType, explicitArgs?: string) => {
    if (!opcodeUrl) return

    setLoading(true)
    const args = explicitArgs ?? ''

    // run id 는 서버가 발급한다. 기록 실패가 커맨드 실행을 막지는 않는다.
    // opencode 가 내려주는 source 로 skill 호출을 구분한다(히스토리/달력 UI는 command 만 표시).
    let currentRunId: string | null = null
    try {
      const run = await createRun.mutateAsync({
        sessionId: sessionID,
        commandName: command.name,
        args,
        directory,
        repoId,
        kind: (command as { source?: string }).source === 'skill' ? 'skill' : 'command',
      })
      currentRunId = run.id
    } catch {
      // onError 에서 이미 토스트 처리됨
    }

    let hasError = false

    try {
      const client = createOpenCodeClient(opcodeUrl, directory)

      // Check if command exists on server (built-in + MCP + skills from fetched list)
      // 드롭다운에서 온 항목은 opencode 목록에 있는 것이므로 source 로 신뢰한다.
      const serverCommandNames = new Set([
        ...SERVER_COMMANDS,
        ...(commands?.map((c: typeof commands[0]) => c.name) ?? [])
      ])
      const isServerCommand =
        (command as { source?: string }).source != null || serverCommandNames.has(command.name)

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
                const matchedRepoId = repoMatch[1]
                const newPath = `/repos/${matchedRepoId}/sessions/${newSession.id}`
                navigate(newPath)
              } else {
                navigate(`/session/${newSession.id}`)
              }
            }
          } catch (error) {
            console.error('Failed to create new session:', error)
            hasError = true
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
            const source = (command as { source?: string; template?: string }).source
            const template = (command as { template?: string }).template
            if (source === 'skill') {
              // opencode HTTP command 엔드포인트는 skill 실행을 500 으로 거절한다.
              // TUI 와 동일하게 스킬 본문을 프롬프트로 보내 모델이 skill 을 로드하게 한다.
              const text = args ? `${template ?? `/${command.name}`}\n\n${args}` : (template ?? `/${command.name}`)
              await client.sendPrompt(sessionID, { parts: [{ type: 'text', text }] })
            } else {
              await client.sendCommand(sessionID, {
                command: command.name,
                arguments: args
              })
            }
          } else {
            showToast.warning(
              `Unknown command: "/${command.name}". Available: ${[...serverCommandNames].join(', ')}`
            )
          }
      }
    } catch (error) {
      console.error('Failed to execute command:', error)
      hasError = true
    } finally {
      setLoading(false)
      if (currentRunId) {
        finishRun.mutate({
          id: currentRunId,
          status: hasError ? 'failed' : 'completed',
        })
      }
    }
  }, [
    sessionID, opcodeUrl, directory, repoId,
    onShowSessionsDialog, onShowModelsDialog, onShowHelpDialog,
    createSession, navigate, commands, createRun, finishRun,
  ])

  return {
    executeCommand,
    loading
  }
}
