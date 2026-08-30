import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { createOpenCodeClient } from '@/api/opencode'
import { useCreateSession } from '@/hooks/useOpenCode'
import type { CommandWithScope } from '@/hooks/useCommands'
import { useCreateCommandRun, useFinishCommandRun } from '@/hooks/useCommandRuns'
import { useSettings } from '@/hooks/useSettings'
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
  const queryClient = useQueryClient()
  const createSession = useCreateSession(opcodeUrl, directory)
  const { preferences } = useSettings()
  const [loading, setLoading] = useState(false)

  const createRun = useCreateCommandRun()
  const finishRun = useFinishCommandRun()

  const executeCommand = useCallback(async (command: CommandType, explicitArgs?: string) => {
    if (!opcodeUrl) return

    setLoading(true)
    const args = explicitArgs ?? ''

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

      const serverCommandNames = new Set([
        ...SERVER_COMMANDS,
        ...(commands?.map((c: typeof commands[0]) => c.name) ?? [])
      ])
      const isServerCommand =
        (command as { source?: string }).source != null || serverCommandNames.has(command.name)

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
          try {
            const newSession = await createSession.mutateAsync({ agent: undefined })
            if (newSession?.id) {
              const currentPath = window.location.pathname
              const repoMatch = currentPath.match(/\/repos\/(\d+)\/sessions\//)
              if (repoMatch) {
                navigate(`/repos/${repoMatch[1]}/sessions/${newSession.id}`)
              } else {
                navigate(`/session/${newSession.id}`)
              }
            }
          } catch (error) {
            console.error('Failed to create new session:', error)
            hasError = true
          }
          break

        // opencode 의 요약은 메시지를 지우지 않는다. 요약 메시지를 하나 추가하고
        // 세션의 컨텍스트 시작점만 그 지점으로 옮긴다. 세션 ID 도 그대로다.
        case 'compact':
        case 'summarize': {
          const [providerID, modelID] = (preferences?.defaultModel ?? '').split('/')
          if (!providerID || !modelID) {
            showToast.warning('먼저 모델을 선택하세요. 요약에는 providerID/modelID 가 필요합니다.')
            hasError = true
            break
          }
          const isEmpty = !result || (typeof result === 'object' && Object.keys(result).length === 0)
          if (isEmpty) {
            showToast.warning('요약 응답이 비어 있습니다. 타임아웃일 수 있으니 메시지 목록을 확인하세요.')
            hasError = true
          } else {
            showToast.success('컨텍스트를 요약했습니다.')
          }
          await queryClient.invalidateQueries({ queryKey: ['messages', opcodeUrl, sessionID] })
          await queryClient.invalidateQueries({ queryKey: ['session', opcodeUrl, sessionID] })
          break
        }

        case 'share':
        case 'unshare':
        case 'export':
        case 'undo':
        case 'redo':
        case 'details':
        case 'editor':
          showToast.warning(
            `"/${command.name}" is not supported in the web UI. This command runs only in the terminal (TUI).`
          )
          break

        default:
          if (isServerCommand) {
            const source = (command as { source?: string; template?: string }).source
            const template = (command as { template?: string }).template
            if (source === 'skill') {
              const text = args ? `${template ?? `/${command.name}`}\n\n${args}` : (template ?? `/${command.name}`)
              await client.sendPrompt(sessionID, { parts: [{ type: 'text', text }] })
            } else {
              await client.sendCommand(sessionID, { command: command.name, arguments: args })
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
    preferences?.defaultModel, queryClient,
  ])

  return { executeCommand, loading }
}
