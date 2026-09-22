import type { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'
import type { PermissionRule } from '../types/permission-rule'

/**
 * DB permission_rules(전역) → opencode.json permission 블록 렌더러.
 * 백엔드 자동승인은 사후 응답이라 opencode 재기동 시 ask가 부활한다
 * (opencode의 always는 프로세스 메모리에만 남는다).
 * 전역 allow 룰을 config 파일에 써두면 재기동 후에도 ask 자체가 안 생긴다.
 * opencode는 permission을 기동 시점에만 읽으므로, 파일 변경은 다음
 * opencode 시작부터 적용된다. 그 전에는 live 자동승인(SSE+sweep)이 커버한다.
 * → 룰 변경 후 즉시 적용하려면 opencode 재시작(POST /api/opencode-restart).
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

/**
 * 우리 glob → opencode 패턴. opencode의 '*'는 '/'를 포함한 모든 문자라
 * 우리 '**'는 '*'로 접는다. 단일 '*'·'?'는 그대로 둔다.
 */
export function toOpencodePattern(pattern: string): string {
  return pattern.split('**').join('*')
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
    const pattern = toOpencodePattern((r.pattern ?? '').trim())
    if (!pattern) continue
    // catch-all('*' 단독)은 렌더하지 않는다 — 모든 명령 무조건 허용이 되는데
    // 보통은 입력 실수다. 필요하면 명시적으로 다시 논의한다.
    if (pattern === '*') {
      logger.warn(`Skipping catch-all permission rule #${r.id} (${r.permission}) in opencode config render`)
      continue
    }
    const keys = r.permission === '*' ? PERMISSION_CONFIG_KEYS : [r.permission]
    for (const k of keys) {
      if (!k) continue
      ;(out[k] ??= {})[pattern] = 'allow'
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
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const fs = await import('fs/promises')
  const { default: path } = await import('path')
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, content, 'utf-8')
  await fs.rename(tmp, filePath)
}

/**
 * 전역 룰을 default opencode config(DB row + 디스크 파일)에 반영한다.
 * 직전 렌더는 sidecar 파일에 보관하고, 사라진 항목만 제거한다.
 * 반환값: true면 DB row 또는 디스크 파일 중 하나라도 실제로 바뀌었다
 * (호출부가 "재시작 필요" 판단에 쓸 수 있다).
 */
export async function syncPermissionConfigToDisk(db: Database): Promise<boolean> {
  try {
    const { listGlobalPermissionRules } = await import('../db/permission-rule-queries')
    const rendered = renderPermissionConfig(listGlobalPermissionRules(db))
    const { SettingsService } = await import('./settings')
    const settingsService = new SettingsService(db)
    const defaultConfig = settingsService.getDefaultOpenCodeConfig()
    if (!defaultConfig) return false
    const { getOpenCodeConfigFilePath } = await import('@opencode-webui/shared')
    const { readFileContent } = await import('./file-operations')
    const configPath = getOpenCodeConfigFilePath()
    // opencode가 config 디렉터리를 스캔해도 집지 않게 .json으로 끝나지 않게 한다.
    const sidecarPath = `${configPath}.webui-permission`
    let previous: Record<string, Record<string, string>> = {}
    try {
      const raw = await readFileContent(sidecarPath)
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        previous = parsed as Record<string, Record<string, string>>
      }
    } catch {
      // 첫 실행 — sidecar 없음
    }
    const merged = mergePermissionConfigInto(
      defaultConfig.content as Record<string, unknown>,
      rendered,
      previous
    )
    const before = JSON.stringify(
      ((defaultConfig.content as Record<string, unknown>).permission as unknown) ?? null
    )
    const after = JSON.stringify((merged.permission as unknown) ?? null)
    const rowChanged = before !== after
    if (rowChanged) {
      settingsService.updateOpenCodeConfig(defaultConfig.name, { content: merged }, 'default')
      logger.info('Merged global permission allow rules into default opencode config')
    }
    // 디스크 파일의 이전 내용과도 비교한다 (수기 편집·재빌드 직후 어긋남 대비).
    let diskChanged = true
    try {
      const diskRaw = await readFileContent(configPath)
      const diskJson = JSON.parse(diskRaw) as { permission?: unknown }
      diskChanged =
        JSON.stringify(diskJson?.permission ?? null) !==
        JSON.stringify((merged.permission as unknown) ?? null)
    } catch {
      diskChanged = true
    }
    await writeFileAtomic(configPath, JSON.stringify(merged, null, 2))
    try {
      await writeFileAtomic(sidecarPath, JSON.stringify(rendered, null, 2))
    } catch (e) {
      logger.warn('Permission render sidecar write failed:', e instanceof Error ? e.message : e)
    }
    return rowChanged || diskChanged
  } catch (e) {
    // config 쓰기 실패는 증상이 원래 버그와 똑같다 (재기동하면 또 물어봄).
    // debug에 묻히면 다음 제보 때 원인 추적이 어려우니 warn이다.
    logger.warn('Permission config sync failed:', e instanceof Error ? e.message : e)
    return false
  }
}

// fire-and-forget 연속 호출 직렬화. 겹치면 sidecar diff 기준이 어긋나
// 삭제된 룰이 잔류한다. CRUD 핸들러는 이걸 쓴다.
let syncChain: Promise<unknown> = Promise.resolve()

export function queuePermissionConfigSync(db: Database): Promise<unknown> {
  syncChain = syncChain.then(() => syncPermissionConfigToDisk(db)).catch(() => {})
  return syncChain
}
