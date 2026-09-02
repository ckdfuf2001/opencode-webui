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

async function waitForAssistantCompleted(
  client: ReturnType<typeof createOpenCodeClient>,
  sessionID: string,
  startMs: number,
): Promise<void> {
  const deadline = Date.now() + 120_000
  let noCandidateTicks = 0
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700))
    try {
      const msgs = await client.listMessages(sessionID) as unknown as { info: { role: string; time: { created?: number; completed?: number } } }[]
      if (!msgs || msgs.length === 0) continue
      const candidates = msgs.filter(
        (m) => m.info.role === 'assistant' && (m.info.time.created ?? 0) >= startMs - 5_000,
      )
      if (candidates.length === 0) {
        // No new assistant yet — likely command with no LLM output (e.g. quick tool). Don't block long.
        if (++noCandidateTicks >= 4) return
        continue
      }
      noCandidateTicks = 0
      const target = candidates[candidates.length - 1]
      if (target.info.time.completed) return
    } catch {
      // transient — keep polling
    }
  }
}

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
            showToast.warning('Select a model first. Summarize requires providerID/modelID.')
            hasError = true
            break
          }
          const result = await client.summarizeSession(sessionID, providerID, modelID)
          // axios 인터셉터가 timeout 을 조용히 {} 로 삼키므로 성공을 단정하지 않는다.
          const isEmpty = !result || (typeof result === 'object' && Object.keys(result).length === 0)
          // upstream 은 성공 시 boolean 을 반환한다. 명시적 false 는 요약 실패를 뜻한다.
          const failed = result === false
          if (isEmpty) {
            showToast.warning('The summarize response was empty. This may be a timeout — check the message list.')
            hasError = true
          } else if (failed) {
            showToast.warning('Summarize (compact) did not complete. It may have failed because the context is too large — try truncating previous messages.')
            hasError = true
          } else {
            showToast.warning('Context summarized — handled autonomously by the WebUI.')
          }
          await queryClient.invalidateQueries({ queryKey: ['messages', opcodeUrl, sessionID] })
          await queryClient.invalidateQueries({ queryKey: ['session', opcodeUrl, sessionID] })
          break
        }
        case 'share': {
          try {
            await navigator.clipboard.writeText(window.location.href)
          } catch {
            const ta = document.createElement('textarea')
            ta.value = window.location.href
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            document.body.removeChild(ta)
          }
          showToast.warning('Share link copied to clipboard — handled by the WebUI.')
          break
        }
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
              const startMs = Date.now()
              await client.sendPrompt(sessionID, { parts: [{ type: 'text', text }] })
              // 2번: opencode 응답의 time.completed 플래그로 끝 판단 (채팅 분할 대응)
              await waitForAssistantCompleted(client, sessionID, startMs)
            } else {
              const startMs = Date.now()
              await client.sendCommand(sessionID, { command: command.name, arguments: args })
              await waitForAssistantCompleted(client, sessionID, startMs)
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
