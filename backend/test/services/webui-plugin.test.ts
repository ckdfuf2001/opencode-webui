import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const workspaceBase = { current: '' }

vi.mock('@opencode-webui/shared', () => ({
  getWorkspacePath: () => workspaceBase.current,
  getReposPath: () => path.join(workspaceBase.current, 'repos'),
  getConfigPath: () => path.join(workspaceBase.current, '.config', 'opencode'),
  getOpenCodeConfigFilePath: () => path.join(workspaceBase.current, '.config', 'opencode', 'opencode.json'),
  ENV: { SERVER: { PORT: 5001 }, LOGGING: { DEBUG: false } },
}))

import { ensureWebuiPlugin, webuiPluginPath, webuiHookEnv } from '../../src/services/webui-plugin'

describe('webui-plugin', () => {
  let base: string

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'webui-plugin-'))
    workspaceBase.current = base
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('writes the plugin file (directory auto-load, no config-array entry)', () => {
    ensureWebuiPlugin()
    const pluginPath = webuiPluginPath()
    expect(existsSync(pluginPath)).toBe(true)
    const src = readFileSync(pluginPath, 'utf8')
    // 관측만: 두 이벤트만 전달하고 네트워크를 await하지 않는다
    expect(src).toContain('command.executed')
    expect(src).toContain('session.idle')
    expect(src).not.toMatch(/await\s+fetch/)
  })

  it('removes the obsolete plugin-array entry but keeps other config', () => {
    const cfgPath = path.join(base, '.config', 'opencode', 'opencode.json')
    mkdirSync(path.dirname(cfgPath), { recursive: true })
    writeFileSync(
      cfgPath,
      JSON.stringify({ $schema: 'x', model: 'a/b', plugin: ['other', webuiPluginPath()] }, null, 2),
    )
    ensureWebuiPlugin()
    ensureWebuiPlugin()
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { model?: string; plugin?: string[] }
    expect(cfg.model).toBe('a/b')
    expect(cfg.plugin).toContain('other')
    expect(cfg.plugin ?? []).not.toContain(webuiPluginPath())
  })

  it('exposes the hook callback URL from server env', () => {
    expect(webuiHookEnv()).toEqual({ WEBUI_HOOK_URL: 'http://127.0.0.1:5001/api/command-hooks/event' })
  })
})

