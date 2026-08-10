import type { QueryClient } from "@tanstack/react-query";
import type { MessageListResponse, MessageWithParts } from "@/api/types";

export const ERROR_MESSAGE_ID_PREFIX = "__error__";

function makeErrorMessage(sessionID: string, text: string, now = Date.now()): MessageWithParts {
  const id = `${ERROR_MESSAGE_ID_PREFIX}${now}_${Math.random().toString(36).slice(2)}`
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: now, completed: now },
      system: [],
      parentID: "",
      modelID: "",
      providerID: "",
      mode: "build",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageWithParts["info"],
    parts: [
      {
        id: `${id}_part`,
        sessionID,
        messageID: id,
        type: "text",
        text,
      } as MessageWithParts["parts"][number],
    ],
  }
}

export function appendErrorMessageToThread(
  queryClient: QueryClient,
  opcodeUrl: string | null | undefined,
  sessionID: string,
  directory: string | undefined,
  text: string,
): void {
  if (!opcodeUrl || !sessionID) return
  const key = ["opencode", "messages", opcodeUrl, sessionID, directory] as const
  const now = Date.now()
  const existing = queryClient.getQueryData<MessageListResponse>(key) ?? []

  const alreadyHasError = existing.some(
    (m) => m.info.id.startsWith(ERROR_MESSAGE_ID_PREFIX) && m.info.time.created === now,
  )
  if (alreadyHasError) return

  const message = makeErrorMessage(sessionID, text, now)

  const alreadyInList = existing.some(
    (m) =>
      m.info.id === message.info.id ||
      (m.info.id.startsWith(ERROR_MESSAGE_ID_PREFIX) &&
        m.parts[0]?.type === "text" &&
        (m.parts[0] as { text?: string }).text === text &&
        now - m.info.time.created < 5000),
  )
  if (alreadyInList) return

  queryClient.setQueryData<MessageListResponse>(key, [...existing, message])
}
