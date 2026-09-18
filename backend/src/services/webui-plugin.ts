import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getConfigPath, getOpenCodeConfigFilePath, ENV } from '@opencode-webui/shared'
import { logger } from '../utils/logger'

/**
 * opencode 후크 플러그인 — 단일 소스(아래 WEBUI_PLUGIN_SOURCE)를
 * 관리 글로벌 플러그인 디렉토리에 기록한다. dev·portable·docker 전부 같은 경로로 동작한다.
 *
 * 등록 방식 주의: config `plugin` 배열은 npm 패키지용이라 로컬 파일이 안 탄다.
 * 로컬 파일은 플러그인 디렉토리에서만 자동 로드된다. 스폰 시 OPENCODE_CONFIG_DIR이
 * 관리 설정 경로를 가리키므로, 그 밑 plugins/에 두면 글로벌 플러그인으로 로드된다.
 *
 * 설계 원칙:
 * - 플러그인은 관측만 한다. POST는 절대 await하지 않아 에이전트에 지연을 주지 않는다.
 * - 판단(기록/종료/리뷰)은 전부 백엔드가 한다. 플러그인은 이벤트 전달자다.
 * - WEBUI_HOOK_URL이 없으면(외부 서버 등) 조용히 비활성화된다.
 * - 받는 이벤트는 command.executed + session.idle 둘뿐. 나머지는 opencode 내부에서만 돈다.
 */
const WEBUI_PLUGIN_SOURCE = [
  'export const WebuiHooksPlugin = async () => {',
  '  let hookUrl = ""',
  '  try { hookUrl = String((globalThis.process && globalThis.process.env && globalThis.process.env.WEBUI_HOOK_URL) || "").replace(/\\/+$/, "") } catch (e) {}',
  '  let warned = false',
  '  const post = (body) => {',
  '    if (!hookUrl) {',
  '      if (!warned) { warned = true; try { console.log("[webui-hooks] WEBUI_HOOK_URL missing - disabled") } catch (e) {} }',
  '      return',
  '    }',
  '    try {',
  '      const r = fetch(hookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })',
  '      if (r && typeof r.catch === "function") r.catch(() => {})',
  '    } catch (e) {}',
  '  }',
  '  post({ type: "plugin.ready", at: Date.now() })',
  '  return {',
  '    event: async (e) => {',
  '      try {',
  '        const ev = (e && e.event) || e || {}',
  '        const t = ev.type',
  '        if (t !== "command.executed" && t !== "session.idle") return',
  '        const p = ev.properties || {}',
  '        if (!p.sessionID) return',
  '        if (t === "command.executed") {',
  '          post({ type: "command.executed", sessionID: p.sessionID, name: p.name, args: p.arguments, messageID: p.messageID })',
  '        } else {',
  '          post({ type: "session.idle", sessionID: p.sessionID })',
  '        }',
  '      } catch (e) {}',
  '    },',
  '  }',
  '}',
  '',
].join('\n')

export function webuiPluginPath(): string {
  return path.join(getConfigPath(), 'plugins', 'webui-hooks.ts')
}

/** 스폰된 opencode 서버에 전달할 후크 env. 포트는 백엔드 리슨 포트와 동일. */
export function webuiHookEnv(): Record<string, string> {
  return { WEBUI_HOOK_URL: `http://127.0.0.1:${ENV.SERVER.PORT}/api/command-hooks/event` }
}

/**
 * 플러그인 파일을 관리 글로벌 플러그인 디렉토리에 기록한다 (멱등).
 * opencode가 스폰 시 OPENCODE_CONFIG_DIR 밑 plugins/를 글로벌 플러그인으로 자동 로드한다.
 * 기존에 config `plugin` 배열로 등록했던 잔재가 있으면 제거한다 (npm용이라 로컬 파일이 안 탐).
 */
export function ensureWebuiPlugin(): void {
  try {
    const pluginPath = webuiPluginPath()
    mkdirSync(path.dirname(pluginPath), { recursive: true })
    let current = ''
    try {
      current = readFileSync(pluginPath, 'utf8')
    } catch {}
    if (current !== WEBUI_PLUGIN_SOURCE) {
      writeFileSync(pluginPath, WEBUI_PLUGIN_SOURCE, 'utf8')
      logger.info(`WebUI hooks plugin written to ${pluginPath}`)
    }

    try {
      const configPath = getOpenCodeConfigFilePath()
      const raw = readFileSync(configPath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const content = parsed as Record<string, unknown>
        if (Array.isArray(content.plugin)) {
          const cleaned = (content.plugin as unknown[]).filter((p) => p !== pluginPath)
          if (cleaned.length !== (content.plugin as unknown[]).length) {
            if (cleaned.length === 0) delete content.plugin
            else content.plugin = cleaned
            writeFileSync(configPath, `${JSON.stringify(content, null, 2)}\n`, 'utf8')
            logger.info('Removed obsolete plugin-array entry (directory auto-load is used)')
          }
        }
      }
    } catch {}
  } catch (e) {
    logger.warn('Failed to ensure WebUI hooks plugin:', e)
  }
}
