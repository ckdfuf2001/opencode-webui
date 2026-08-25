import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { OpenCodeClient } from "../api/opencode";
import type {
  MessageWithParts,
  MessageListResponse,
  ContentPart,
} from "../api/types";
import type { paths } from "../api/opencode-types";
import { showToast } from "@/lib/toast"
import { markSessionIdle } from "./useSessionActivity"
import { listSessionStatuses } from "@/api/session-status"

type SendPromptRequest = NonNullable<
  paths["/session/{id}/message"]["post"]["requestBody"]
>["content"]["application/json"];

/** 낙관 abort 직후 폴링이 미처리 상태를 되살려 뱃지가 깜빡이는 것을 막는 가드. */
const RECENTLY_ABORTED_MS = 12_000;
const recentlyAborted = new Map<string, number>();

/** 전송 중인 낙관 user 메시지. 2s 폴링이 캐시를 덮어써도 유지된다. */
const pendingOptimistic = new Map<string, MessageWithParts>();

/** truncate 직후 opencode 메모리가 옛 목록을 돌려줄 수 있어 뷰를 유지하는 가드.
 *  시간이 아닌 "제거된 메시지 ID" 기준으로 걸러 새 메시지는 즉시 통과된다. */
const RECENTLY_TRUNCATED_MS = 12_000;
const recentlyTruncated = new Map<string, { until: number; removedIds: Set<string> }>();

function applyTruncationWindow(
  sessionID: string,
  data: MessageListResponse,
): MessageListResponse {
  const entry = recentlyTruncated.get(sessionID);
  if (!entry) return data;
  if (Date.now() > entry.until) {
    recentlyTruncated.delete(sessionID);
    return data;
  }
  return data.filter((m) => !entry.removedIds.has(m.info.id));
}

function isRecentlyAborted(sessionID: string): boolean {
  const at = recentlyAborted.get(sessionID);
  if (!at) return false;
  if (Date.now() - at > RECENTLY_ABORTED_MS) {
    recentlyAborted.delete(sessionID);
    return false;
  }
  return true;
}

type PromptPart = NonNullable<SendPromptRequest["parts"]>[number];

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

function mimeForFilename(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}

// opencode providers only accept image/*, audio/*, text/* and application/pdf
// as inline file parts. Everything else (office docs, json, binaries) must go
// as a text mention so the agent can read it with doc-reader instead of the
// request failing with "file part media type ... not supported".
function canSendAsFilePart(mime: string): boolean {
  return (
    mime === "application/pdf" ||
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("text/")
  )
}

function isAbortCancellation(error: unknown): boolean {
  if (error && typeof error === "object") {
    const code = (error as { code?: string }).code
    if (code === "ERR_CANCELED" || code === "ECONNABORTED") return true
    const message = (error as { message?: string }).message
    if (typeof message === "string" && /cancel|abort/i.test(message)) return true
  }
  return false
}

// Format server error similar to OpenCode's formatServerError
function formatServerError(error: unknown): string {
  // Axios error with response
  if (error && typeof error === "object" && "response" in error) {
    const axiosError = error as { response?: { data?: unknown; status?: number } }
    const data = axiosError.response?.data
    if (data && typeof data === "object") {
      const errorData = data as Record<string, unknown>
      // OpenCode server error format: { _tag: "ErrorName", message: "...", ... }
      if (typeof errorData.message === "string" && errorData.message.length > 0) {
        return errorData.message
      }
      if (typeof errorData._tag === "string") {
        return errorData._tag
      }
    }
    if (axiosError.response?.status === 429) return "Rate limit exceeded. Please wait before sending more requests."
    if (axiosError.response?.status === 401) return "Authentication failed. Check your API key."
    if (axiosError.response?.status === 403) return "Access denied."
  }
  // Native Error
  if (error instanceof Error && error.message) return error.message
  // String error
  if (typeof error === "string" && error.length > 0) return error
  return "An unexpected error occurred."
}

export const useOpenCodeClient = (opcodeUrl: string | null | undefined, directory?: string) => {
  return useMemo(
    () => (opcodeUrl ? new OpenCodeClient(opcodeUrl, directory) : null),
    [opcodeUrl, directory],
  );
};

export function isInterruptedMessage(msg: MessageWithParts | undefined | null): boolean {
  if (!msg) return false
  if (msg.info.role !== 'assistant') return false
  if ("completed" in msg.info.time && msg.info.time.completed) return false
  return true
}

export async function continueInterruptedSession(
  client: OpenCodeClient,
  sessionID: string,
): Promise<boolean> {
  try {
    const status = await client.getSessionStatus()
    if (status[sessionID]?.type === 'busy') return false
    const messages = await client.listMessages(sessionID)
    const last = messages[messages.length - 1]
    if (!isInterruptedMessage(last)) return false
    await client.sendPrompt(sessionID, { parts: [{ type: 'text', text: 'Continue' }] })
    return true
  } catch {
    return false
  }
}

export const useSessions = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useQuery({
    queryKey: ["opencode", "sessions", opcodeUrl, directory],
    queryFn: () => client!.listSessions(),
    enabled: !!client,
    refetchInterval: 2000,
  });
};

export const useSession = (opcodeUrl: string | null | undefined, sessionID: string | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useQuery({
    queryKey: ["opencode", "session", opcodeUrl, sessionID, directory],
    queryFn: () => client!.getSession(sessionID!),
    enabled: !!client && !!sessionID,
  });
};

export const useMessages = (opcodeUrl: string | null | undefined, sessionID: string | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useQuery({
    queryKey: ["opencode", "messages", opcodeUrl, sessionID, directory],
    queryFn: async () => {
      const data = await client!.listMessages(sessionID!);
      let result = applyTruncationWindow(sessionID!, data);
      const optimistic = pendingOptimistic.get(sessionID!);
      const realUserArrived =
        optimistic != null &&
        result.some(
          (m) =>
            m.info.role === "user" &&
            (m.info.time?.created ?? 0) >= (optimistic.info.time?.created ?? 0),
        );
      if (optimistic && !realUserArrived && !result.some((m) => m.info.id === optimistic.info.id)) {
        result = [...result, optimistic];
      }
      if (isRecentlyAborted(sessionID!)) {
        return reconcileOrphanedStreams(result, sessionID!, false);
      }
      const status = await client!.getSessionStatus().catch(() => null);
      if (status === null) return result;
      const isBusy = status[sessionID!]?.type === "busy";
      return reconcileOrphanedStreams(result, sessionID!, isBusy);
    },
    enabled: !!client && !!sessionID,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 10 * 60 * 1000,
    placeholderData: (previousData) => previousData,
    refetchInterval: 2000,
  });
};

function reconcileOrphanedStreams(
  messages: MessageListResponse,
  sessionID: string,
  isBusy: boolean,
): MessageListResponse {
  if (isBusy) return messages;
  let changed = false;
  // idle 상태에서 파트 없는 미완료 assistant 메시지는 유령 카드이므로 제거한다.
  const filtered = messages.filter((msg) => {
    const ghost =
      msg.info.sessionID === sessionID &&
      msg.info.role === "assistant" &&
      !("completed" in msg.info.time && msg.info.time.completed) &&
      msg.parts.length === 0;
    if (ghost) changed = true;
    return !ghost;
  });
  const updated = filtered.map((msg): MessageWithParts => {
    if (msg.info.sessionID !== sessionID) return msg;
    if (msg.info.role !== "assistant") return msg;
    if ("completed" in msg.info.time && msg.info.time.completed) return msg;
    changed = true;
    const parts = msg.parts.map((part) => {
      if (part.type === "tool" && part.state?.status === "running") {
        return {
          ...part,
          state: { status: "error" as const, error: "Run was interrupted" },
        } as MessageWithParts["parts"][number];
      }
      return part;
    });
    return {
      ...msg,
      info: {
        ...msg.info,
        time: { ...msg.info.time, completed: msg.info.time.created ?? Date.now() },
      },
      parts,
    };
  });
  return changed ? updated : messages;
}

export const useReconcileOrphanedStreams = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const status = await client.getSessionStatus();
        if (cancelled || !status) return;
        const queries = queryClient.getQueryCache().getAll();
        for (const query of queries) {
          const key = query.queryKey;
          if (key[0] !== "opencode" || key[1] !== "messages") continue;
          if (key[2] !== opcodeUrl || key[4] !== directory) continue;
          const sessionID = key[3];
          if (typeof sessionID !== "string" || !sessionID) continue;
          if (status[sessionID]?.type === "busy") continue;
          const data = query.state.data as MessageListResponse | undefined;
          if (!data) continue;
          const reconciled = reconcileOrphanedStreams(data, sessionID, false);
          if (reconciled !== data) {
            queryClient.setQueryData(key, reconciled);
            markSessionIdle(sessionID);
          }
        }
      } catch {
        // status endpoint unavailable; skip this cycle
      }
    };

    tick();
    const interval = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [client, queryClient, opcodeUrl, directory]);
};

export const useCreateSession = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: {
      title?: string;
      agent?: string;
      model?: string;
    }) => {
      if (!client) throw new Error("No client available");
      return client.createSession(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opencode", "sessions", opcodeUrl, directory] });
    },
  });
};

export const useDeleteSession = (opcodeUrl: string | null | undefined, directory?: string) => {
  const queryClient = useQueryClient();
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useMutation({
    mutationFn: async (sessionIDs: string | string[]) => {
      if (!client) {
        throw new Error('OpenCode client not available');
      }
      
      const ids = Array.isArray(sessionIDs) ? sessionIDs : [sessionIDs]
      
      const deletePromises = ids.map(async (sessionID) => {
        await client.deleteSession(sessionID);
      })
      
      const results = await Promise.allSettled(deletePromises)
      const failures = results.filter(result => result.status === 'rejected')
      
      if (failures.length > 0) {
        throw new Error(`Failed to delete ${failures.length} session(s)`)
      }
      
      return results
    },
    onSuccess: (_data, variables) => {
      const ids = Array.isArray(variables) ? variables : [variables];
      const sessionsKey = ["opencode", "sessions", opcodeUrl, directory] as const;
      const current = queryClient.getQueryData<{ id: string }[]>(sessionsKey);
      if (current) {
        queryClient.setQueryData(
          sessionsKey,
          current.filter((s) => !ids.includes(s.id)),
        );
      }
      queryClient.invalidateQueries({ queryKey: sessionsKey });
    },
  });
};

export const useTruncateSession = (opcodeUrl: string | null | undefined, directory?: string) => {
  const queryClient = useQueryClient();
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useMutation({
    mutationFn: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
      if (!client) throw new Error("No client available");
      return client.truncateSession(sessionID, messageID);
    },
    onMutate: async ({ sessionID, messageID }) => {
      const messagesKey = ["opencode", "messages", opcodeUrl, sessionID, directory] as const;
      await queryClient.cancelQueries({ queryKey: messagesKey });
      const previous = queryClient.getQueryData<MessageListResponse>(messagesKey);
      const cursor = previous?.find((m) => m.info.id === messageID);
      if (previous && cursor) {
        const cursorTime = cursor.info.time?.created ?? 0;
        const removedIds = new Set(
          previous
            .filter((m) => (m.info.time?.created ?? 0) >= cursorTime)
            .map((m) => m.info.id),
        );
        recentlyTruncated.set(sessionID, {
          until: Date.now() + RECENTLY_TRUNCATED_MS,
          removedIds,
        });
        queryClient.setQueryData<MessageListResponse>(messagesKey, () =>
          previous.filter((m) => (m.info.time?.created ?? 0) < cursorTime),
        );
      }
      return { messagesKey, previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.messagesKey, context.previous);
      }
    },
    onSettled: (_data, _error, variables) => {
      const { sessionID } = variables;
      queryClient.invalidateQueries({ queryKey: ["opencode", "session", opcodeUrl, sessionID, directory] });
      queryClient.invalidateQueries({ queryKey: ["opencode", "messages", opcodeUrl, sessionID, directory] });
    },
  });
};

export const useUpdateSession = (opcodeUrl: string | null | undefined, directory?: string) => {
  const queryClient = useQueryClient();
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useMutation({
    mutationFn: async ({ sessionID, title }: { sessionID: string; title: string }) => {
      if (!client) throw new Error("No client available");
      return client.updateSession(sessionID, { title });
    },
    onSuccess: (_, variables) => {
      const { sessionID } = variables;
      queryClient.invalidateQueries({ queryKey: ["opencode", "session", opcodeUrl, sessionID, directory] });
      queryClient.invalidateQueries({ queryKey: ["opencode", "sessions", opcodeUrl, directory] });
    },
  });
};

const createOptimisticUserMessage = (
  sessionID: string,
  parts: ContentPart[],
  optimisticID: string,
): MessageWithParts => {
  const messageParts = parts.flatMap((part, index): MessageWithParts["parts"] => {
    if (part.type === "text") {
      return [{
        id: `${optimisticID}_part_${index}`,
        type: "text" as const,
        text: part.content,
        messageID: optimisticID,
        sessionID,
      }];
    }
    if (!canSendAsFilePart(mimeForFilename(part.name))) {
      return [{
        id: `${optimisticID}_part_${index}`,
        type: "text" as const,
        text: mentionFor(part),
        messageID: optimisticID,
        sessionID,
      }];
    }
    return [{
      id: `${optimisticID}_part_${index}`,
      type: "file" as const,
      mime: mimeForFilename(part.name),
      filename: part.name,
      url: part.path,
      messageID: optimisticID,
      sessionID,
    }];
  });

  return {
    info: {
      id: optimisticID,
      role: "user",
      sessionID,
      time: { created: Date.now() },
    },
    parts: messageParts,
  } as MessageWithParts;
};

const mentionFor = (part: ContentPart & { name: string; path: string }): string => {
  const path = part.path.replace(/^file:\/{2,3}/, "").replace(/\\/g, "/")
  const chatIdx = path.indexOf("/chat_uploads/")
  if (chatIdx >= 0) {
    return `@"${path.slice(chatIdx + 1)}"`
  }
  const reposIdx = path.indexOf("/repos/")
  const rel = reposIdx >= 0 ? path.slice(reposIdx + "/repos/".length).split("/").slice(1).join("/") : part.name
  return `@"${rel}"`
};

export const useSendPrompt = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionID,
      prompt,
      parts,
      model,
      agent,
    }: {
      sessionID: string;
      prompt?: string;
      parts?: ContentPart[];
      model?: string;
      agent?: string;
    }) => {
      if (!client) throw new Error("No client available");

      const optimisticUserID = `optimistic_user_${Date.now()}_${Math.random()}`;

      const contentParts = parts || [{ type: "text" as const, content: prompt || "", name: "" }];

      const userMessage = createOptimisticUserMessage(
        sessionID,
        contentParts,
        optimisticUserID,
      );
      pendingOptimistic.set(sessionID, userMessage);
      queryClient.setQueryData<MessageListResponse>(
        ["opencode", "messages", opcodeUrl, sessionID, directory],
        (old) => [...(old || []), userMessage],
      );

      const requestData: SendPromptRequest = {
        parts: parts?.flatMap((part): PromptPart[] => {
          if (part.type === "text") {
            return [{ type: "text", text: part.content }]
          }
          const mime = mimeForFilename(part.name)
          if (!canSendAsFilePart(mime)) {
            return [{ type: "text", text: mentionFor(part) }]
          }
          return [{
            type: "file",
            mime,
            filename: part.name,
            url: part.path.startsWith("file:")
              ? part.path
              : `file:///${part.path.replace(/\\/g, "/").replace(/ /g, "%20")}`,
          }]
        }) || [{ type: "text", text: prompt || "" }],
      };

      if (model) {
        const [providerID, modelID] = model.split("/");
        if (providerID && modelID) {
          requestData.model = {
            providerID,
            modelID,
          };
        }
      }

      if (agent) {
        requestData.agent = agent;
      }

      const response = await client.sendPrompt(sessionID, requestData);

      return { optimisticUserID, response };
    },
    onSettled: (_data, _error, variables) => {
      pendingOptimistic.delete(variables.sessionID);
    },
    onError: (error, variables) => {
      const { sessionID } = variables;
      const formatted = formatServerError(error)
      queryClient.setQueryData<MessageListResponse>(
        ["opencode", "messages", opcodeUrl, sessionID, directory],
        (old) => old?.filter((msg) => !msg.info.id.startsWith("optimistic_")),
      );
      if (!isAbortCancellation(error)) {
        showToast.error(formatted, { duration: 8000 });
      }
    },
    onSuccess: (data, variables) => {
      const { sessionID } = variables;
      const { optimisticUserID } = data;

      queryClient.setQueryData<MessageListResponse>(
        ["opencode", "messages", opcodeUrl, sessionID, directory],
        (old) => old?.filter((msg) => msg.info.id !== optimisticUserID) || [],
      );

      queryClient.invalidateQueries({
        queryKey: ["opencode", "session", opcodeUrl, sessionID, directory],
      });
    },
  });
};

export const useSessionStatusMap = () => {
  return useQuery({
    queryKey: ["session-status-db"],
    queryFn: listSessionStatuses,
    refetchInterval: 2000,
    staleTime: 0,
  });
};

export const useAbortSession = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionID: string) => {
      if (!client) throw new Error("No client available");
      await client.abortSession(sessionID);
    },
    onMutate: (sessionID) => {
      recentlyAborted.set(sessionID, Date.now());
      markSessionMessagesCompleted(queryClient, opcodeUrl, directory, sessionID);
    },
    onSettled: (_data, _error, sessionID) => {
      markSessionMessagesCompleted(queryClient, opcodeUrl, directory, sessionID);
      queryClient.invalidateQueries({ queryKey: ['opencode', 'sessions', opcodeUrl, directory] })
    },
  });
};

function markSessionMessagesCompleted(
  queryClient: ReturnType<typeof useQueryClient>,
  opcodeUrl: string | null | undefined,
  directory: string | undefined,
  sessionID: string,
) {
  const messagesKey = ['opencode', 'messages', opcodeUrl, sessionID, directory] as const
  const data = queryClient.getQueryData<MessageListResponse>(messagesKey)
  if (!data) return
  let changed = false
  const updated: MessageListResponse = []
  for (const msg of data) {
    if (msg.info.role !== 'assistant') {
      updated.push(msg)
      continue
    }
    if ('completed' in msg.info.time && msg.info.time.completed) {
      updated.push(msg)
      continue
    }
    changed = true
    // 빈 placeholder(파트 없는 미완료 카드)는 완료 처리 대신 제거한다.
    if (msg.parts.length === 0) continue
    updated.push({ ...msg, info: { ...msg.info, time: { ...msg.info.time, completed: Date.now() } } })
  }
  if (changed) {
    queryClient.setQueryData(messagesKey, updated)
  }
}

export const useSendShell = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionID,
      command,
      agent,
    }: {
      sessionID: string;
      command: string;
      agent?: string;
    }) => {
      if (!client) throw new Error("No client available");

      const optimisticUserID = `optimistic_user_${Date.now()}_${Math.random()}`;

      const userMessage = createOptimisticUserMessage(
        sessionID,
        [{ type: "text" as const, content: command }],
        optimisticUserID,
      );
      queryClient.setQueryData<MessageListResponse>(
        ["opencode", "messages", opcodeUrl, sessionID, directory],
        (old) => [...(old || []), userMessage],
      );

      const response = await client.sendShell(sessionID, {
        command,
        agent: agent || "general",
      });

      return { optimisticUserID, response };
    },
    onError: (error, variables) => {
      const { sessionID } = variables;
      const formatted = formatServerError(error)
      queryClient.setQueryData<MessageListResponse>(
        ["opencode", "messages", opcodeUrl, sessionID, directory],
        (old) => old?.filter((msg) => !msg.info.id.startsWith("optimistic_")),
      );
      if (!isAbortCancellation(error)) {
        showToast.error(formatted, { duration: 8000 });
      }
    },
    onSuccess: (data, variables) => {
      const { sessionID } = variables;
      const { optimisticUserID } = data;

      queryClient.setQueryData<MessageListResponse>(
        ["opencode", "messages", opcodeUrl, sessionID, directory],
        (old) => old?.filter((msg) => msg.info.id !== optimisticUserID) || [],
      );

      queryClient.invalidateQueries({
        queryKey: ["opencode", "session", opcodeUrl, sessionID, directory],
      });
    },
  });
};

export const useConfig = (opcodeUrl: string | null | undefined, directory?: string) => {
  const client = useOpenCodeClient(opcodeUrl, directory);

  return useQuery({
    queryKey: ["opencode", "config", opcodeUrl, directory],
    queryFn: () => client!.getConfig(),
    enabled: !!client,
  });
};
