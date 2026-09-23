import type { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'
import type { PermissionRule } from '../types/permission-rule'

/**
 * DB permission_rules(전역) → opencode.json permission 블록 렌더러.
 *
 * v0.12.0: 기본 OFF. 소유권은 webui DB가 갖고, 매 ask를 live 자동승인자가
 * 'once'로 응답한다 (opencode 메모리는 stateless — 재기동 전/후 동일 동작).
 * 파일에 allow를 미리 써두면 ask 자체가 안 생겨 가로채기가 우회되므로,
 * 파일 렌더는 opt-in이다: WEBUI_PERMISSION_FILE_SYNC=1 일 때만 전역 룰을
 * opencode.json에 쓴다 (다음 opencode 시작부터 적용 — opencode는 permission을
 * 기동 시점에만 읽는다. 즉시 적용하려면 POST /api/opencode-restart).
 * OFF 상태에서도 sidecar diff로 이전 렌더분은 1회 정리된다 (수기 항목 유지).
 *
 * 스키마: OPENCODE_PERMISSION_SCHEMA=v1|v2 (기본 v1 = 번들 v1.18.x).
 * v2 바이너리로 교체하면 v2로 바꿔 permissions 배열로 렌더한다.
 */

// opencode config permission 키. '*' 룰은 전부로 확장한다.
// 단 doom_loop는 제외 — 리소스 스코프가 아니라 무한반복 안전장치라
// 경로 패턴 하나로 풀리면 안 된다. 필요하면 doom_loop를 명시 지정해야 한다.
export const PERMISSION_CONFIG_KEYS = [
  'bash',
  'edit',
  'read',
  'webfetch',
  'websearch',
  'glob',
  'grep',
  'task',
  'skill',
  'external_directory',
]

/** 파일 렌더 opt-in 플래그. 기본 OFF — 룰은 live once-승인으로만 강제된다. */
export function isPermissionFileSyncEnabled(): boolean {
  return process.env.WEBUI_PERMISSION_FILE_SYNC === '1'
}

/** 렌더 스키마 선택. v2 바이너리로 교체했을 때만 'v2'로 바꾼다. */
export function getPermissionSchema(): 'v1' | 'v2' {
  return process.env.OPENCODE_PERMISSION_SCHEMA === 'v2' ? 'v2' : 'v1'
}

// v1 → v2 액션명 매핑 (DB 룰은 v1 명칭으로 저장). 매핑 없는 키는 그대로 둔다.
const V1_TO_V2_ACTION: Record<string, string> = {
  bash: 'shell',
  task: 'subagent',
}

export const V2_PERMISSION_ACTIONS = [
  'shell',
  'edit',
  'read',
  'webfetch',
  'websearch',
  'glob',
  'grep',
  'subagent',
  'skill',
  'external_directory',
]

export interface V2PermissionEntry {
  action: string
  resource: string
  effect: 'allow'
}

function toV2Actions(permission: string): string[] {
  if (permission === '*') return [...V2_PERMISSION_ACTIONS]
  const lower = (permission ?? '').toLowerCase()
  if (!lower) return []
  if (lower === 'doom_loop') return ['doom_loop']
  return [V1_TO_V2_ACTION[lower] ?? permission]
}

function isCatchAllPattern(raw: string): boolean {
  return !raw.replace(/\\/g, '/').replace(/\*/g, '').replace(/\//g, '')
}

/**
 * 우리 패턴 → opencode 패턴 목록.
 * opencode 신 semantics에서는 '*'가 '/'를 넘지 못하고 '**'만 재귀다
 * (구버전은 '*'가 전부라 달랐다). 하위까지 커버되게 변형을 함께 내보낸다.
 * 구버전 호환용 '*'형 + 신버전용 '**'형을 둘 다 넣는다 (중복 무해).
 * - 'C:/data/*' → ['C:/data/*', 'C:/data/**']
 * - 'C:/data/**' → ['C:/data/**', 'C:/data/*']
 * - 'C:/data' (경로형 확정) → [원본, 'C:/data/*', 'C:/data/**']
 *   (백엔드 매칭이 prefix=하위 포함이라 config도 맞춘다)
 * - bash 명령 등 비경로형 → [원본] 그대로
 */
function isPathLikePattern(p: string): boolean {
  return (
    p.includes('/') ||
    p.includes('\\') ||
    /^[A-Za-z]:/.test(p) ||
    p.startsWith('~') ||
    p.startsWith('$HOME')
  )
}

export function toOpencodePatterns(pattern: string): string[] {
  const p = (pattern ?? '').trim()
  if (!p) return []
  if (!isPathLikePattern(p)) return [p]
  const out: string[] = [p]
  const norm = p.replace(/\\/g, '/')
  const push = (v: string) => {
    if (v && !out.includes(v)) out.push(v)
  }
  if (norm.endsWith('/**')) {
    push(norm.slice(0, -1))
  } else if (norm.endsWith('/*')) {
    push(`${norm}*`)
  } else {
    const base = norm.replace(/\/+$/, '')
    push(`${base}/*`)
    push(`${base}/**`)
  }
  return out
}

/**
 * v2 스키마 렌더: permissions: [{ action, resource, effect: 'allow' }].
 * 전역 룰만, catch-all 제외, 오래된 것부터 (뒤 규칙이 이긴다) — v1과 동일 정책.
 * doom_loop는 v2 코어 액션이 아니라 제외한다.
 */
export function renderPermissionConfigV2(rules: PermissionRule[]): V2PermissionEntry[] {
  const out: V2PermissionEntry[] = []
  const seen = new Set<string>()
  const ordered = [...rules]
    .filter((r) => r.repoId == null)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id - b.id)
  for (const r of ordered) {
    const raw = (r.pattern ?? '').trim()
    if (!raw) continue
    if (isCatchAllPattern(raw)) {
      logger.warn(`Skipping catch-all permission rule #${r.id} (${r.permission}) in v2 opencode config render`)
      continue
    }
    if ((r.permission ?? '').toLowerCase() === 'doom_loop') {
      logger.warn(`Skipping doom_loop rule #${r.id} in v2 render (not a v2 core action)`)
      continue
    }
    for (const action of toV2Actions(r.permission)) {
      for (const resource of toOpencodePatterns(raw)) {
        const key = `${action}\n${resource}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ action, resource, effect: 'allow' })
      }
    }
  }
  return out
}

/**
 * v2 배열 병합: 직전 렌더(sidecar-v2)에 있던 항목만 제거하고 이번 렌더를 추가.
 * 수기 entries는 유지된다. effect가 allow가 아닌 수기 항목은 건드리지 않는다.
 */
export function mergePermissionConfigV2Into<T extends Record<string, unknown>>(
  content: T,
  rendered: V2PermissionEntry[],
  previous: V2PermissionEntry[] = [],
): T {
  const existing = (content as Record<string, unknown>).permissions
  const list: V2PermissionEntry[] = Array.isArray(existing)
    ? (existing as V2PermissionEntry[]).filter((e) => e && typeof e === 'object')
    : []
  const prevKeys = new Set(previous.map((e) => `${e.action}\n${e.resource}`))
  const kept = list.filter((e) => !prevKeys.has(`${(e as V2PermissionEntry).action}\n${(e as V2PermissionEntry).resource}`))
  const next = [...kept]
  for (const e of rendered) {
    if (!next.some((k) => k.action === e.action && k.resource === e.resource)) next.push(e)
  }
  if (next.length === 0) {
    const { permissions: _drop, ...rest } = content as Record<string, unknown> & { permissions?: unknown }
    return rest as T
  }
  return { ...content, permissions: next }
}

/**
 * 전역 룰(repoId null)만 렌더한다. 레포별 룰은 세션 스코프라 config 파일로
 * 옮기지 않는다 (옮기면 전역 허용이 되어버린다).
 * 순서는 오래된 것부터 — opencode는 뒤에 오는 규칙이 이기므로
 * 새로 만든 룰이 이전 룰을 덮는다.
 */
export function renderPermissionConfig(
  rules: PermissionRule[]
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  const ordered = [...rules]
    .filter((r) => r.repoId == null)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id - b.id)
  for (const r of ordered) {
    const raw = (r.pattern ?? '').trim()
    if (!raw) continue
    // catch-all('*'·'**' 단독 등, 와일드카드·슬래시만)은 렌더하지 않는다 —
    // 모든 명령 무조건 허용이 되는데 보통은 입력 실수다.
    if (!raw.replace(/\\/g, '/').replace(/\*/g, '').replace(/\//g, '')) {
      logger.warn(`Skipping catch-all permission rule #${r.id} (${r.permission}) in opencode config render`)
      continue
    }
    const keys = r.permission === '*' ? PERMISSION_CONFIG_KEYS : [r.permission]
    for (const k of keys) {
      if (!k) continue
      for (const pattern of toOpencodePatterns(raw)) {
        ;(out[k] ??= {})[pattern] = 'allow'
      }
    }
  }
  return out
}

/**
 * 렌더 결과를 config content.permission에 합친다.
 * - 새로 렌더된 항목은 덮어쓴다 (DB가 우선).
 * - 직전 렌더(sidecar)에 있었는데 이번에 사라진 항목은 제거한다
 *   (룰 삭제 시 파일에 잔류 방지). 그 외 수기 항목은 유지한다.
 * - 결과가 비게 된 tool 키는 정리한다.
 */
export function mergePermissionConfigInto<T extends Record<string, unknown>>(
  content: T,
  rendered: Record<string, Record<string, string>>,
  previous: Record<string, Record<string, string>> = {}
): T {
  const existing = (content as Record<string, unknown>).permission
  const base: Record<string, Record<string, string>> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (JSON.parse(JSON.stringify(existing)) as Record<string, Record<string, string>>)
      : {}
  const tools = new Set([...Object.keys(previous), ...Object.keys(rendered)])
  for (const tool of tools) {
    base[tool] ??= {}
    for (const pattern of Object.keys(previous[tool] ?? {})) {
      if (!(pattern in (rendered[tool] ?? {}))) delete base[tool][pattern]
    }
    for (const [pattern, decision] of Object.entries(rendered[tool] ?? {})) {
      base[tool][pattern] = decision
    }
    if (Object.keys(base[tool]).length === 0) delete base[tool]
  }
  return { ...content, permission: base }
}

/**
 * 원자적 파일 쓰기 (temp + rename). 쓰는 도중 opencode가 기동해도
 * 잘린 JSON을 읽지 않는다.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const fs = await import('fs/promises')
  const { default: path } = await import('path')
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, content, 'utf-8')
  await fs.rename(tmp, filePath)
}

async function readSidecarJson<T>(sidecarPath: string, fallback: T, isValid: (v: unknown) => v is T): Promise<T> {
  const { readFileContent } = await import('./file-operations')
  try {
    const raw = await readFileContent(sidecarPath)
    const parsed: unknown = JSON.parse(raw)
    if (isValid(parsed)) return parsed
  } catch {
    // 첫 실행 — sidecar 없음
  }
  return fallback
}

/**
 * 전역 룰 렌더를 content에 합치고 sidecar를 갱신한다.
 * DB row·파일 쓰기는 호출자가 한다 (호출 경로마다 row 처리·원자적 쓰기가 다르다).
 *
 * v0.12.0: WEBUI_PERMISSION_FILE_SYNC=1 일 때만 렌더한다. OFF면 빈 렌더로
 * 합쳐 이전 렌더분을 1회 정리한다 (수기 항목은 유지). 스키마 전환(v1↔v2) 시에도
 * 반대편 sidecar 기준으로 반대편 렌더분을 정리한다.
 */
export async function applyGlobalPermissionRules(
  db: Database,
  content: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { listGlobalPermissionRules } = await import('../db/permission-rule-queries')
  const rules = listGlobalPermissionRules(db)
  const fileSync = isPermissionFileSyncEnabled()
  const schema = getPermissionSchema()
  const renderedV1 = fileSync && schema === 'v1' ? renderPermissionConfig(rules) : {}
  const renderedV2 = fileSync && schema === 'v2' ? renderPermissionConfigV2(rules) : []
  const { getOpenCodeConfigFilePath } = await import('@opencode-webui/shared')
  const sidecarPath = `${getOpenCodeConfigFilePath()}.webui-permission`
  const sidecarV2Path = `${sidecarPath}-v2`
  const previous = await readSidecarJson<Record<string, Record<string, string>>>(
    sidecarPath, {}, (v): v is Record<string, Record<string, string>> => !!v && typeof v === 'object' && !Array.isArray(v),
  )
  const previousV2 = await readSidecarJson<V2PermissionEntry[]>(
    sidecarV2Path, [], (v): v is V2PermissionEntry[] => Array.isArray(v),
  )
  let merged = mergePermissionConfigInto(content, renderedV1, previous)
  merged = mergePermissionConfigV2Into(merged, renderedV2, previousV2)
  try {
    await writeFileAtomic(sidecarPath, JSON.stringify(renderedV1, null, 2))
    await writeFileAtomic(sidecarV2Path, JSON.stringify(renderedV2, null, 2))
  } catch (e) {
    logger.warn('Permission render sidecar write failed:', e instanceof Error ? e.message : e)
  }
  if (!fileSync && rules.length > 0) {
    logger.info(
      `Permission file sync is off (WEBUI_PERMISSION_FILE_SYNC!=1): ${rules.length} global rule(s) enforced live via once-replies only, not written to opencode.json`,
    )
  }
  return merged
}

/**
 * 전역 룰을 default opencode config(DB row + 디스크 파일)에 반영한다.
 * 직전 렌더는 sidecar 파일에 보관하고, 사라진 항목만 제거한다.
 * 반환값: true면 DB row 또는 디스크 파일 중 하나라도 실제로 바뀌었다
 * (호출부가 "재시작 필요" 판단에 쓸 수 있다).
 */
export async function syncPermissionConfigToDisk(db: Database): Promise<boolean> {
  try {
    const { SettingsService } = await import('./settings')
    const settingsService = new SettingsService(db)
    const defaultConfig = settingsService.getDefaultOpenCodeConfig()
    if (!defaultConfig) return false
    const { getOpenCodeConfigFilePath } = await import('@opencode-webui/shared')
    const { readFileContent } = await import('./file-operations')
    const configPath = getOpenCodeConfigFilePath()
    const merged = await applyGlobalPermissionRules(
      db,
      defaultConfig.content as Record<string, unknown>
    )
    const permOf = (c: Record<string, unknown>): string =>
      JSON.stringify([(c.permission as unknown) ?? null, (c.permissions as unknown) ?? null])
    const rowChanged = permOf(defaultConfig.content as Record<string, unknown>) !== permOf(merged)
    if (rowChanged) {
      settingsService.updateOpenCodeConfig(defaultConfig.name, { content: merged }, 'default')
      logger.info('Merged global permission allow rules into default opencode config')
    }
    // 디스크 파일의 이전 내용과도 비교한다 (수기 편집·재빌드 직후 어긋남 대비).
    // 파일 부재(ENOENT)는 쓸 내용이 비어있으면 변경 없음, 파싱 실패는 보수적으로 변경 취급.
    let diskChanged = true
    try {
      const diskRaw = await readFileContent(configPath)
      const diskJson = JSON.parse(diskRaw) as Record<string, unknown>
      diskChanged = permOf(diskJson) !== permOf(merged)
    } catch (e) {
      const code = (e as { code?: unknown })?.code
      if (code === 'ENOENT') {
        diskChanged =
          Object.keys((merged.permission as Record<string, unknown> | undefined) ?? {}).length > 0 ||
          ((merged.permissions as unknown[]) ?? []).length > 0
      } else {
        diskChanged = true
      }
    }
    await writeFileAtomic(configPath, JSON.stringify(merged, null, 2))
    return rowChanged || diskChanged
  } catch (e) {
    // config 쓰기 실패는 증상이 원래 버그와 똑같다 (재기동하면 또 물어봄).
    // debug에 묻히면 다음 제보 때 원인 추적이 어려우니 warn이다.
    logger.warn('Permission config sync failed:', e instanceof Error ? e.message : e)
    return false
  }
}

// fire-and-forget 연속 호출 직렬화. 겹치면 sidecar diff 기준이 어긋나
// 삭제된 룰이 잔류한다. opencode.json을 쓰는 모든 경로는 이 큐를 탄다
// (룰 CRUD·부팅 MCP sync·수기 저장 — 각자 자기 시점 content 전체를 쓰므로
// 직렬화하지 않으면 나중 쓰기가 앞선 쓰기를 통째로 덮는다).
let configWriteChain: Promise<unknown> = Promise.resolve()

export function queueConfigWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = configWriteChain.then(task)
  configWriteChain = result.catch(() => {})
  return result
}

export function queuePermissionConfigSync(db: Database): Promise<boolean> {
  return queueConfigWrite(() => syncPermissionConfigToDisk(db))
}
