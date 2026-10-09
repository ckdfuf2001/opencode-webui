import { z } from "zod";

export const CustomCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  promptTemplate: z.string(),
  steps: z.array(z.string()).default([]),
});

export const TTSConfigSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string(),
  apiKey: z.string(),
  voice: z.string(),
  model: z.string(),
  speed: z.number().min(0.25).max(4.0),
});

export const CustomAgentSchema = z.object({
  name: z.string(),
  description: z.string(),
  config: z.record(z.string(), z.any()),
});

export const DEFAULT_KEYBOARD_SHORTCUTS = {
  submit: "Ctrl+Enter",
  abort: "Escape",
  toggleMode: "Tab",
  undo: "Ctrl+Z",
  redo: "Ctrl+Shift+Z",
  compact: "Alt+C",
  fork: "Ctrl+Shift+F",
  settings: "Ctrl+,",
  sessions: "Ctrl+S",
  newSession: "Alt+N",
  closeSession: "Alt+W",
  toggleSidebar: "Ctrl+B",
  selectModel: "Ctrl+M",
};

export const DEFAULT_REPO_TRACK_PATHS = [".opencode", "scripts"];

export const DEFAULT_BLOCKED_UPLOAD_EXTENSIONS = [
  ".exe", ".bat", ".cmd", ".com", ".scr", ".vbs", ".ps1", ".msi", ".dll", ".lnk",
];

export const UserPreferencesSchema = z.object({
  theme: z.enum(["dark", "light", "system"]),
  mode: z.enum(["plan", "build"]),
  defaultModel: z.string().optional(),
  defaultAgent: z.string().optional(),
  autoScroll: z.boolean(),
  showReasoning: z.boolean(),
  expandToolCalls: z.boolean(),
  keyboardShortcuts: z.record(z.string(), z.string()),
  customCommands: z.array(CustomCommandSchema),
  customAgents: z.array(CustomAgentSchema),
  gitToken: z.string().optional(),
  opencodeBin: z.string().optional(),
  tts: TTSConfigSchema.optional(),
  repoTrackPaths: z.array(z.string()).default(DEFAULT_REPO_TRACK_PATHS),
  // 채팅 파일 업로드 차단 확장자 (소문자 .ext 형태). 비워두면 전부 허용.
  blockedUploadExtensions: z.array(z.string()).default(DEFAULT_BLOCKED_UPLOAD_EXTENSIONS),
  autoRecallEnabled: z.boolean().default(true),
  recallTopK: z.number().int().min(1).max(10).default(4),
  completionSoundEnabled: z.boolean().default(true),
  completionSoundOnCancel: z.boolean().default(true),
  pushNotificationEnabled: z.boolean().default(false),
  pushNotificationDuration: z.number().int().min(0).max(86400).default(0),
  // SSE 스트리밍: reasoning·응답 델타를 실시간 병합. off면 폴링만으로 갱신. 기본 off
  // (on이 기본이면 설정 변경과 무관하게 true로 부활한다 — 프론트 기본값과 통일).
  sseStreaming: z.boolean().default(false),
  // 취소(Stop) 시 대기 중인 큐 전송도 함께 멈출지. 기본 false = 큐는 계속 발송.
  // true면 Stop이 큐를 일시정지하고, 사용자가 재생 버튼으로 재개해야 한다.
  cancelStopsQueue: z.boolean().default(false),
});

export const DEFAULT_TTS_CONFIG = {
  enabled: false,
  endpoint: "https://api.openai.com/v1/audio/speech",
  apiKey: "",
  voice: "alloy",
  model: "tts-1",
  speed: 1.0,
};

export const DEFAULT_USER_PREFERENCES = {
  theme: "light" as const,
  mode: "build" as const,
  autoScroll: true,
  showReasoning: true,
  expandToolCalls: false,
  keyboardShortcuts: DEFAULT_KEYBOARD_SHORTCUTS,
  customCommands: [],
  customAgents: [],
  gitToken: undefined,
  tts: DEFAULT_TTS_CONFIG,
  repoTrackPaths: DEFAULT_REPO_TRACK_PATHS,
  blockedUploadExtensions: DEFAULT_BLOCKED_UPLOAD_EXTENSIONS,
  autoRecallEnabled: true,
  recallTopK: 4,
  completionSoundEnabled: true,
  completionSoundOnCancel: true,
  pushNotificationEnabled: false,
  pushNotificationDuration: 0,
  sseStreaming: false,
};

export const SettingsResponseSchema = z.object({
  preferences: UserPreferencesSchema,
  updatedAt: z.number(),
});

export const UpdateSettingsRequestSchema = z.object({
  preferences: UserPreferencesSchema.partial(),
});

export const OpenCodeConfigSchema = z.object({
  $schema: z.string().optional(),
  theme: z.string().optional(),
  model: z.string().optional(),
  small_model: z.string().optional(),
  provider: z.record(z.string(), z.any()).optional(),
  agent: z.record(z.string(), z.any()).optional(),
  command: z.record(z.string(), z.any()).optional(),
  keybinds: z.record(z.string(), z.any()).optional(),
  autoupdate: z.boolean().optional(),
  formatter: z.record(z.string(), z.any()).optional(),
  permission: z.record(z.string(), z.any()).optional(),
  mcp: z.record(z.string(), z.any()).optional(),
  instructions: z.array(z.string()).optional(),
  disabled_providers: z.array(z.string()).optional(),
  share: z.string().optional(),
});

export const OpenCodeConfigMetadataSchema = z.object({
  id: z.number(),
  name: z.string().min(1).max(255),
  content: OpenCodeConfigSchema,
  isDefault: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const CreateOpenCodeConfigRequestSchema = z.object({
  name: z.string().min(1).max(255),
  content: OpenCodeConfigSchema,
  isDefault: z.boolean().optional(),
});

export const UpdateOpenCodeConfigRequestSchema = z.object({
  content: OpenCodeConfigSchema,
  isDefault: z.boolean().optional(),
});

export const OpenCodeConfigResponseSchema = z.object({
  configs: z.array(OpenCodeConfigMetadataSchema),
  defaultConfig: OpenCodeConfigMetadataSchema.nullable(),
});
