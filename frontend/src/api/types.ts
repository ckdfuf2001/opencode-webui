export interface Repo {
  id: number
  repoUrl: string
  localPath: string
  fullPath: string
  branch?: string
  currentBranch?: string
  defaultBranch: string
  cloneStatus: 'cloning' | 'ready' | 'error'
  clonedAt: number
  lastPulled?: number
  openCodeConfigName?: string
  isWorktree?: boolean
}

import type { components } from './opencode-types'

export type Message = components['schemas']['Message']
export type Part = components['schemas']['Part']
export type Session = components['schemas']['Session']
export type Permission = components['schemas']['Permission']
export type PermissionResponse = 'once' | 'always' | 'reject'

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: {
    id?: string
    args?: Record<string, unknown>
  }
}

export type MessageWithParts = {
  info: Message
  parts: Part[]
}

export type MessageListResponse = MessageWithParts[]

export interface SSEMessagePartUpdatedEvent {
  type: 'message.part.updated' | 'messagev2.part.updated'
  properties: {
    part: Part
  }
}

export interface SSEMessageUpdatedEvent {
  type: 'message.updated' | 'messagev2.updated'
  properties: {
    info: Message
  }
}

export interface SSEMessageRemovedEvent {
  type: 'message.removed' | 'messagev2.removed'
  properties: {
    sessionID: string
    messageID: string
  }
}

export interface SSEMessagePartRemovedEvent {
  type: 'message.part.removed' | 'messagev2.part.removed'
  properties: {
    sessionID: string
    messageID: string
    partID: string
  }
}

export interface SSESessionUpdatedEvent {
  type: 'session.updated'
  properties: {
    info: Session
  }
}

export interface SSESessionDeletedEvent {
  type: 'session.deleted'
  properties: {
    sessionID: string
  }
}

export interface SSESessionCompactedEvent {
  type: 'session.compacted'
  properties: {
    sessionID: string
  }
}

export interface SSETodoUpdatedEvent {
  type: 'todo.updated'
  properties: {
    sessionID: string
    todos: components['schemas']['Todo'][]
  }
}

export interface PermissionAskedProps {
  id: string
  sessionID: string
  permission?: string
  type?: string
  pattern?: string | string[]
  patterns?: string[]
  always?: string[]
  metadata?: Record<string, unknown>
  tool?: {
    messageID?: string
    callID?: string
  }
  title?: string
  time?: {
    created: number
  }
}

export interface SSEPermissionAskedEvent {
  type: 'permission.asked' | 'permission.updated'
  properties: PermissionAskedProps
}

export interface SSEPermissionRepliedEvent {
  type: 'permission.replied'
  properties: {
    sessionID: string
    requestID?: string
    permissionID?: string
    reply?: string
    response?: string
  }
}

export interface SSEQuestionAskedEvent {
  type: 'question.asked' | 'question.v2.asked'
  properties: QuestionRequest
}

export interface SSEQuestionRepliedEvent {
  type: 'question.replied' | 'question.v2.replied'
  properties: {
    id: string
    sessionID: string
    answers: string[][]
  }
}

export interface SSEQuestionRejectedEvent {
  type: 'question.rejected' | 'question.v2.rejected'
  properties: {
    id: string
    sessionID: string
  }
}

export interface SSEInstallationUpdatedEvent {
  type: 'installation.updated'
  properties: {
    version: string
  }
}

export interface SSEInstallationUpdateAvailableEvent {
  type: 'installation.update-available'
  properties: {
    version: string
  }
}

export interface SSESessionCreatedEvent {
  type: 'session.created'
  properties: {
    info: Session
  }
}

export interface SSESessionIdleEvent {
  type: 'session.idle'
  properties: {
    sessionID: string
  }
}

export interface SSESessionErrorEvent {
  type: 'session.error'
  properties: {
    sessionID?: string
    error?: {
      name: string
      data: Record<string, unknown>
    }
  }
}

export interface SSEFileEditedEvent {
  type: 'file.edited'
  properties: {
    file: string
  }
}

export interface SSEFileWatcherUpdatedEvent {
  type: 'file.watcher.updated'
  properties: {
    file: string
    event: 'add' | 'change' | 'unlink'
  }
}

export interface SSECommandExecutedEvent {
  type: 'command.executed'
  properties: {
    name: string
    sessionID: string
    arguments: string
    messageID: string
  }
}

export interface SSELspClientDiagnosticsEvent {
  type: 'lsp.client.diagnostics'
  properties: {
    serverID: string
    path: string
  }
}

export interface SSELspUpdatedEvent {
  type: 'lsp.updated'
  properties: Record<string, never>
}

export interface SSETuiToastShowEvent {
  type: 'tui.toast.show'
  properties: {
    title?: string
    message: string
    variant: 'info' | 'success' | 'warning' | 'error'
    duration: number
  }
}

export interface SSETuiPromptAppendEvent {
  type: 'tui.prompt.append'
  properties: {
    text: string
  }
}

export interface SSETuiCommandExecuteEvent {
  type: 'tui.command.execute'
  properties: {
    command: string
  }
}

export interface SSEServerConnectedEvent {
  type: 'server.connected'
  properties: Record<string, never>
}

export type SSEEvent =
  | SSEMessagePartUpdatedEvent
  | SSEMessageUpdatedEvent
  | SSEMessageRemovedEvent
  | SSEMessagePartRemovedEvent
  | SSESessionUpdatedEvent
  | SSESessionDeletedEvent
  | SSESessionCompactedEvent
  | SSETodoUpdatedEvent
  | SSEPermissionAskedEvent
  | SSEPermissionRepliedEvent
  | SSEQuestionAskedEvent
  | SSEQuestionRepliedEvent
  | SSEQuestionRejectedEvent
  | SSEInstallationUpdatedEvent
  | SSEInstallationUpdateAvailableEvent
  | SSESessionCreatedEvent
  | SSESessionIdleEvent
  | SSESessionErrorEvent
  | SSEFileEditedEvent
  | SSEFileWatcherUpdatedEvent
  | SSECommandExecutedEvent
  | SSELspClientDiagnosticsEvent
  | SSELspUpdatedEvent
  | SSETuiToastShowEvent
  | SSETuiPromptAppendEvent
  | SSETuiCommandExecuteEvent
  | SSEServerConnectedEvent

export type ContentPart = 
  | { type: 'text', content: string }
  | { type: 'file', path: string, name: string }

export interface FileInfo {
  path: string
  name: string
  mime?: string
}
