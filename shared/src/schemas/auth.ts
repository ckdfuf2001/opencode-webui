import { z } from "zod";

/**
 * opencode 의 auth.json 스키마를 그대로 따른다.
 *
 * 예전 webui 는 `{ type: "apiKey", apiKey }` 로 썼는데 opencode 는 이 형식을
 * 모른�� 키를 아예 읽지 않아서, Settings 에서 키를 넣어도 실제 요청에는
 * Authorization 헤더가 붙지 않았다 (401 header of type `authorization` was
 * missing). opencode 가 기대하는 것은 `{ type: "api", key }` 이다.
 *
 * `apiKey` 는 구버전 파일을 읽을 때만 허용한다 — getAll() 이 key 로 정규화하고
 * 다음 set() 부터 새 형식으로 저장한다.
 */
export const AuthEntrySchema = z.object({
  type: z.enum(["api", "oauth"]),
  key: z.string().optional(),
  refresh: z.string().optional(),
  access: z.string().optional(),
  expires: z.number().optional(),
  /** 구버전 webui 필드 (읽기 전용). */
  apiKey: z.string().optional(),
});

export const AuthCredentialsSchema = z.record(z.string(), AuthEntrySchema);

export const SetCredentialRequestSchema = z.object({
  apiKey: z.string().min(1),
});

export const CredentialStatusResponseSchema = z.object({
  hasCredentials: z.boolean(),
});

export const CredentialListResponseSchema = z.object({
  providers: z.array(z.string()),
});
