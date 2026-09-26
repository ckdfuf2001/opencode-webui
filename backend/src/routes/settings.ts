import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import { SettingsService } from '../services/settings'
import { writeActiveOpenCodeConfigFile, setActiveOpenCodeConfigModel } from '../services/default-mcp'
import { patchOpenCodeConfig } from '../services/proxy'
import { AuthService } from '../services/auth'
import { getOpenCodeConfigFilePath, getWorkspacePath } from '@opencode-webui/shared'
import { 
  UserPreferencesSchema, 
  OpenCodeConfigSchema,
} from '../types/settings'
import { logger } from '../utils/logger'
import { opencodeServerManager } from '../services/opencode-single-server'

const UpdateSettingsSchema = z.object({
  preferences: UserPreferencesSchema.partial(),
})

const CreateOpenCodeConfigSchema = z.object({
  name: z.string().min(1).max(255),
  content: OpenCodeConfigSchema,
  isDefault: z.boolean().optional(),
})

const UpdateOpenCodeConfigSchema = z.object({
  content: OpenCodeConfigSchema,
  isDefault: z.boolean().optional(),
})

/**
 * provider 변경 여부. opencode 는 provider 레지스트리를 부팅 시 한 번만
 * 만들기 때문에 config provider 추가/삭제만으로는 반영되지 않는다
 * (MCP 와 달리 재시작 대상). 키 순서 무관하게 비교한다.
 */
export function hasProviderChanged(oldContent: Record<string, unknown>, newContent: Record<string, unknown>): boolean {
  const oldProvider = (oldContent.provider as Record<string, unknown>) || {}
  const newProvider = (newContent.provider as Record<string, unknown>) || {}
  const oldKeys = Object.keys(oldProvider).sort()
  const newKeys = Object.keys(newProvider).sort()
  if (oldKeys.length !== newKeys.length) return true
  if (JSON.stringify(oldKeys) !== JSON.stringify(newKeys)) return true
  for (const key of oldKeys) {
    if (JSON.stringify(oldProvider[key]) !== JSON.stringify(newProvider[key])) return true
  }
  return false
}

const ProviderModelSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  limit: z.object({
    context: z.number().int().positive(),
    output: z.number().int().positive(),
  }).optional(),
  reasoning: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  attachment: z.boolean().optional(),
  temperature: z.boolean().optional(),
})

// opencode provider id 규칙: 소문자/숫자로 시작, 소문자·숫자·.`-`/`_` 허용.
const ProviderIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Provider ID must be lowercase alphanumeric with . _ - (start with letter or digit)')

export const UpsertProviderSchema = z.object({
  id: ProviderIdSchema,
  name: z.string().min(1).max(120).optional(),
  npm: z.string().min(1).max(200).default('@ai-sdk/openai-compatible'),
  baseURL: z.string().url('Base URL must be a valid URL').max(500).optional().or(z.literal('').transform(() => undefined)),
  models: z.record(z.string().min(1).max(200), ProviderModelSchema).optional(),
})

function hasMcpChanged(oldContent: Record<string, unknown>, newContent: Record<string, unknown>): boolean {
  const oldMcp = oldContent.mcp as Record<string, any> || {}
  const newMcp = newContent.mcp as Record<string, any> || {}
  
  const oldKeys = Object.keys(oldMcp).sort()
  const newKeys = Object.keys(newMcp).sort()
  
  if (JSON.stringify(oldKeys) !== JSON.stringify(newKeys)) {
    return true
  }
  
  for (const key of oldKeys) {
    if (JSON.stringify(oldMcp[key]) !== JSON.stringify(newMcp[key])) {
      return true
    }
  }
  
  return false
}

const CreateCustomCommandSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().min(1).max(1000),
  promptTemplate: z.string().min(1).max(10000),
  steps: z.array(z.string()).default([]),
})

const UpdateCustomCommandSchema = z.object({
  description: z.string().min(1).max(1000),
  promptTemplate: z.string().min(1).max(10000),
  steps: z.array(z.string()).default([]),
})

export function createSettingsRoutes(db: Database) {
  const app = new Hono()
  const settingsService = new SettingsService(db)

  app.get('/', async (c) => {
    try {
      const userId = c.req.query('userId') || 'default'
      const settings = settingsService.getSettings(userId)
      return c.json(settings)
    } catch (error) {
      logger.error('Failed to get settings:', error)
      return c.json({ error: 'Failed to get settings' }, 500)
    }
  })

  app.patch('/', async (c) => {
    try {
      const userId = c.req.query('userId') || 'default'
      const body = await c.req.json()
      const validated = UpdateSettingsSchema.parse(body)
      
      const previous = settingsService.getSettings(userId)
      const settings = settingsService.updateSettings(validated.preferences, userId)

      const previousBin = previous.preferences.opencodeBin || null
      const nextBin = settings.preferences.opencodeBin || null
      if (previousBin !== nextBin) {
        opencodeServerManager.setPreferredBinPath(nextBin)
        await opencodeServerManager.restart()
      }

      const prevModel = (previous.preferences as Record<string, unknown>).defaultModel as string | undefined
      const nextModel = (settings.preferences as Record<string, unknown>).defaultModel as string | undefined
      if (prevModel !== nextModel && typeof nextModel === 'string' && nextModel.includes('/')) {
        /*
        //Model 은 매번 주입하고 우리화면에서만 보여줌.
        // 파일에 먼저 기록 (sync) — 프록시(proxy.ts:273)가 새 세션에 즉시 주입하므로 세션은 빠름
        setActiveOpenCodeConfigModel(nextModel)
        // 무거운 작업(파일 패치 + 서버 재시작)은 비동기로 — 응답은 즉시 반환해 UI 블로킹 방지
        void (async () => {
          try {
            await patchOpenCodeConfig({ model: nextModel } as Record<string, unknown>)
            logger.info(`Patched opencode default model to ${nextModel} (async, for next sessions)`)
          } catch (e) {
            logger.warn('Failed to patch opencode default model (async):', e)
          }
          try {
            await opencodeServerManager.restart()
            logger.info(`Restarted OpenCode server to apply default model ${nextModel} (async)`)
          } catch (e) {
            logger.warn('Failed to restart OpenCode server for default model change (async):', e)
          }
        })() */
        logger.info(`Default model changed to ${nextModel} — response returned immediately, restart in background`)
      }

      return c.json(settings)
    } catch (error) {
      logger.error('Failed to update settings:', error)
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid settings data', details: error.issues }, 400)
      }
      return c.json({ error: 'Failed to update settings' }, 500)
    }
  })

  app.delete('/', async (c) => {
    try {
      const userId = c.req.query('userId') || 'default'
      const settings = settingsService.resetSettings(userId)
      return c.json(settings)
    } catch (error) {
      logger.error('Failed to reset settings:', error)
      return c.json({ error: 'Failed to reset settings' }, 500)
    }
  })

  // OpenCode Config routes
  app.get('/opencode-configs', async (c) => {
    try {
      const userId = c.req.query('userId') || 'default'
      const configs = settingsService.getOpenCodeConfigs(userId)
      return c.json(configs)
    } catch (error) {
      logger.error('Failed to get OpenCode configs:', error)
      return c.json({ error: 'Failed to get OpenCode configs' }, 500)
    }
  })

  app.post('/opencode-configs', async (c) => {
    try {
      const userId = c.req.query('userId') || 'default'
      const body = await c.req.json()
      const validated = CreateOpenCodeConfigSchema.parse(body)
      
      const config = settingsService.createOpenCodeConfig(validated, userId)
      
      if (config.isDefault) {
        writeActiveOpenCodeConfigFile(JSON.stringify(config.content, null, 2))
        logger.info(`Wrote default config to: ${getOpenCodeConfigFilePath()}`)
        
        await patchOpenCodeConfig(config.content)
      }
      
      return c.json(config)
    } catch (error) {
      logger.error('Failed to create OpenCode config:', error)
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid config data', details: error.issues }, 400)
      }
      return c.json({ error: 'Failed to create OpenCode config' }, 500)
    }
  })

  app.put('/opencode-configs/:name', async (c) => {
    try {
      const userId = c.req.query('userId') || 'default'
      const configName = c.req.param('name')
      const body = await c.req.json()
      const validated = UpdateOpenCodeConfigSchema.parse(body)
      
      const existingConfig = settingsService.getOpenCodeConfigByName(configName, userId)
      const config = settingsService.updateOpenCodeConfig(configName, validated, userId)
      if (!config) {
        return c.json({ error: 'Config not found' }, 404)
      }
      
      if (config.isDefault) {
        writeActiveOpenCodeConfigFile(JSON.stringify(config.content, null, 2))
        logger.info(`Wrote default config to: ${getOpenCodeConfigFilePath()}`)
        
        await patchOpenCodeConfig(config.content)
        
        if (existingConfig && (hasMcpChanged(existingConfig.content, config.content) || hasProviderChanged(existingConfig.content, config.content))) {
          logger.info('MCP/provider configuration changed, restarting OpenCode server')
          await opencodeServerManager.restart()
        }
      }
      
      return c.json(config)
    } catch (error) {
      logger.error('Failed to update OpenCode config:', error)
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid config data', details: error.issues }, 400)
      }
      return c.json({ error: 'Failed to update OpenCode config' }, 500)
    }
  })

  app.delete('/opencode-configs/:name', async (c) => {
    try {
      const userId = c.req.query('userId') || 'default'
      const configName = c.req.param('name')
      
      const deleted = settingsService.deleteOpenCodeConfig(configName, userId)
      if (!deleted) {
        return c.json({ error: 'Config not found' }, 404)
      }
      
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete OpenCode config:', error)
      return c.json({ error: 'Failed to delete OpenCode config' }, 500)
    }
  })

  app.post('/opencode-configs/:name/set-default', async (c) => {
    try {
      const userId = c.req.query('userId') || 'default'
      const configName = c.req.param('name')
      
      const config = settingsService.setDefaultOpenCodeConfig(configName, userId)
      if (!config) {
        return c.json({ error: 'Config not found' }, 404)
      }
      
      writeActiveOpenCodeConfigFile(JSON.stringify(config.content, null, 2))
      logger.info(`Wrote default config '${configName}' to: ${getOpenCodeConfigFilePath()}`)
      
      await patchOpenCodeConfig(config.content)
      
      return c.json(config)
    } catch (error) {
      logger.error('Failed to set default OpenCode config:', error)
      return c.json({ error: 'Failed to set default OpenCode config' }, 500)
    }
  })

  app.get('/opencode-configs/default', async (c) => {
    try {
      const userId = c.req.query('userId') || 'default'
      const config = settingsService.getDefaultOpenCodeConfig(userId)
      
      if (!config) {
        return c.json({ error: 'No default config found' }, 404)
      }
      
      return c.json(config)
    } catch (error) {
      logger.error('Failed to get default OpenCode config:', error)
      return c.json({ error: 'Failed to get default OpenCode config' }, 500)
    }
  })

  // 기본 설정을 돌려준다. 기본 설정이 아직 없는 초기 상태(=AddProvider의
  // 커스텀 등록이 404로 실패하던 원인)면 'default' 설정을 생성해 준다.
  function ensureDefaultConfig(userId: string) {
    const existing = settingsService.getDefaultOpenCodeConfig(userId)
    if (existing) return existing
    logger.info('No default OpenCode config found — creating empty default for provider registration')
    return settingsService.createOpenCodeConfig({ name: 'default', content: {} }, userId)
  }

  /** config 변경을 저장 → 활성 파일 반영 → opencode 재시작까지 한 번에. */
  async function applyConfigPatch(
    config: { name: string; content: Record<string, unknown>; isDefault: boolean },
    patch: Record<string, unknown>,
    opts?: { reloadOnly?: boolean },
  ) {
    const nextContent = { ...config.content, ...patch }
    const updated = settingsService.updateOpenCodeConfig(config.name, { content: nextContent }, 'default')
    if (!updated) {
      throw new Error('Failed to persist config change')
    }
    if (updated.isDefault) {
      writeActiveOpenCodeConfigFile(JSON.stringify(updated.content, null, 2))
      await patchOpenCodeConfig(updated.content)
      if (opts?.reloadOnly) {
        // 인스턴스 reload 는 전체 재기동보다 가볍다. provider 에 models 만 추가하는
        // 경우(모델 선택창을 여는 동안)에는 이것으로 충분해 UX 가 끊기지 않는다.
        try {
          await opencodeServerManager.reloadAndVerify(getWorkspacePath())
        } catch (error) {
          logger.error('Failed to reload OpenCode instance after config change:', error)
        }
        return updated
      }
      // opencode 는 provider 레지스트리를 부팅 시에 만든다 — 재시작 없이는 반영 안 됨.
      try {
        await opencodeServerManager.restart()
      } catch (error) {
        logger.error('Failed to restart OpenCode after config change:', error)
      }
    }
    return updated
  }

  /**
   * 커스텀 provider 의 모델을 baseURL 에서 조회해 config 에 저장한다.
   *
   * opencode 는 커스텀 provider 에 `models` 선언이 있어야 모델 목록을 만든다.
   * Add Provider 의 Models 칸을 비우면 선언이 없어 목록에 안 뜨고, 보내도
   * `ProviderModelNotFoundError: Model not found: <id>/<model>` 로 실패한다.
   * 조회만 해서 화면에 보여주면 실제로는 못 쓰므로 config 에 반드시 써야 한다.
   */
  app.post('/opencode-configs/:name/providers/:providerId/models/refresh', async (c) => {
    try {
      const configName = c.req.param('name')
      const providerId = c.req.param('providerId')

      const config = configName === 'default'
        ? settingsService.getDefaultOpenCodeConfig('default')
        : settingsService.getOpenCodeConfigByName(configName, 'default')
      if (!config) return c.json({ error: 'Config not found' }, 404)

      const provider = (config.content.provider as Record<string, {
        options?: { baseURL?: string }
        models?: Record<string, { name: string }>
      }>) || {}
      const baseURL = provider[providerId]?.options?.baseURL
      if (!baseURL) return c.json({ error: 'Provider has no baseURL' }, 400)

      const authService = new AuthService()
      const apiKey = await authService.getApiKey(providerId)
      if (!apiKey) return c.json({ error: 'No API key stored for this provider' }, 400)

      const res = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return c.json({ error: `Upstream responded ${res.status}` }, 502)
      const body = await res.json() as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown }> }
      const ids = [...new Set([...(body.data ?? []), ...(body.models ?? [])]
        .map((m) => (typeof m?.id === 'string' ? m.id : ''))
        .filter(Boolean))]
      if (ids.length === 0) return c.json({ error: 'Upstream returned no models' }, 502)

      const entry = provider[providerId] ?? {}
      const models: Record<string, { name: string }> = { ...(entry.models ?? {}) }
      let added = 0
      for (const id of ids) {
        if (!models[id]) {
          models[id] = { name: id }
          added++
        }
      }

      const updated = await applyConfigPatch(
        config,
        { provider: { ...provider, [providerId]: { ...entry, models } } },
        { reloadOnly: true },
      )
      logger.info(`Refreshed models for provider '${providerId}': ${ids.length} available, ${added} newly persisted`)
      return c.json({ success: true, count: ids.length, added, config: updated })
    } catch (error) {
      logger.error('Failed to refresh provider models:', error)
      return c.json({ error: 'Failed to refresh provider models' }, 500)
    }
  })

  // 커스텀 provider 등록(추가/갱신). opencode config 의 provider 레코드 하나를
  // 쓰고 활성 파일·opencode 를 동기화한다. openai 호환 baseURL 은
  // npm('@ai-sdk/openai-compatible') + options.baseURL 조합으로 전달한다.
  app.post('/opencode-configs/:name/providers', async (c) => {
    try {
      const configName = c.req.param('name')
      const validated = UpsertProviderSchema.parse(await c.req.json())

      const config = configName === 'default'
        ? ensureDefaultConfig('default')
        : settingsService.getOpenCodeConfigByName(configName, 'default')
      if (!config) return c.json({ error: 'Config not found' }, 404)

      const currentProvider = (config.content.provider as Record<string, unknown>) || {}
      const existing = (currentProvider[validated.id] as Record<string, unknown> | undefined) || {}
      const entry: Record<string, unknown> = {
        ...existing,
        npm: validated.npm,
        name: validated.name || existing.name || validated.id,
        ...(validated.baseURL ? { options: { ...(existing.options as Record<string, unknown> || {}), baseURL: validated.baseURL } } : {}),
        ...(validated.models && Object.keys(validated.models).length > 0 ? { models: validated.models } : {}),
      }

      const updated = await applyConfigPatch(config, { provider: { ...currentProvider, [validated.id]: entry } })
      logger.info(`Registered provider '${validated.id}' in config '${config.name}'`)
      return c.json({ success: true, config: updated, providerId: validated.id })
    } catch (error) {
      logger.error('Failed to register provider:', error)
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid provider data', details: error.issues }, 400)
      }
      return c.json({ error: 'Failed to register provider' }, 500)
    }
  })

  // provider 제거. 두 가지를 모두 처리한다.
  // - 커스텀(config 의 provider 레코드): 레코드를 지운다.
  // - opencode 기본 제공분(레코드가 없음): 지울 대상이 없으므로 disabled_providers 로
  //   숨기고 저장된 키를 지운다. 그래야 목록에서 사라져 "삭제"로 의미가 맞는다.
  app.delete('/opencode-configs/:name/providers/:providerId', async (c) => {
    try {
      const configName = c.req.param('name')
      const providerId = c.req.param('providerId')

      const config = configName === 'default'
        ? settingsService.getDefaultOpenCodeConfig('default')
        : settingsService.getOpenCodeConfigByName(configName, 'default')
      if (!config) return c.json({ error: 'Config not found' }, 404)

      const currentProvider = (config.content.provider as Record<string, unknown>) || {}
      const currentDisabled = Array.isArray(config.content.disabled_providers)
        ? (config.content.disabled_providers as string[])
        : []
      const isCustom = providerId in currentProvider
      if (!isCustom && currentDisabled.includes(providerId)) {
        return c.json({ error: 'Provider is already removed' }, 409)
      }

      const patch: Record<string, unknown> = isCustom
        ? (() => {
            const { [providerId]: _removed, ...rest } = currentProvider
            return { provider: rest }
          })()
        : { disabled_providers: [...currentDisabled, providerId] }

      const updated = await applyConfigPatch(config, patch)

      // auth.json 에 키를 남겨두면 provider 가 사라진 뒤에도 키가 고아로 남는다 —
      // 같이 지워야 재등록 시 새 키를 넣는 흐름이 깨끗해진다.
      let credentialsRemoved = false
      try {
        const authService = new AuthService()
        if (await authService.has(providerId)) {
          await authService.delete(providerId)
          credentialsRemoved = true
        }
      } catch (error) {
        logger.error(`Failed to clear credentials for provider '${providerId}':`, error)
      }

      logger.info(
        `Removed provider '${providerId}' from config '${config.name}' `
        + `(mode: ${isCustom ? 'custom record' : 'disabled_providers'}, credentials cleared: ${credentialsRemoved})`,
      )
      return c.json({ success: true, config: updated, credentialsRemoved, mode: isCustom ? 'unregistered' : 'disabled' })
    } catch (error) {
      logger.error('Failed to remove provider:', error)
      return c.json({ error: 'Failed to remove provider' }, 500)
    }
  })

  app.post('/opencode-restart', async (c) => {
    try {
      logger.info('Manual OpenCode server restart requested')
      await opencodeServerManager.restart()
      return c.json({ success: true, message: 'OpenCode server restarted successfully' })
    } catch (error) {
      logger.error('Failed to restart OpenCode server:', error)
      return c.json({ error: 'Failed to restart OpenCode server' }, 500)
    }
  })

  // Custom Commands routes
  app.get('/custom-commands', async (c) => {
    try {
      const userId = c.req.query('userId') || 'default'
      const settings = settingsService.getSettings(userId)
      return c.json(settings.preferences.customCommands)
    } catch (error) {
      logger.error('Failed to get custom commands:', error)
      return c.json({ error: 'Failed to get custom commands' }, 500)
    }
  })

  app.post('/custom-commands', async (c) => {
    try {
      const userId = c.req.query('userId') || 'default'
      const body = await c.req.json()
      const validated = CreateCustomCommandSchema.parse(body)
      
      const settings = settingsService.getSettings(userId)
      const existingCommand = settings.preferences.customCommands.find(cmd => cmd.name === validated.name)
      if (existingCommand) {
        return c.json({ error: 'Command with this name already exists' }, 409)
      }
      
      settingsService.updateSettings({
        customCommands: [...settings.preferences.customCommands, validated]
      }, userId)
      
      return c.json(validated)
    } catch (error) {
      logger.error('Failed to create custom command:', error)
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid command data', details: error.issues }, 400)
      }
      return c.json({ error: 'Failed to create custom command' }, 500)
    }
  })

  app.put('/custom-commands/:name', async (c) => {
    try {
      const userId = c.req.query('userId') || 'default'
      const commandName = decodeURIComponent(c.req.param('name'))
      const body = await c.req.json()
      const validated = UpdateCustomCommandSchema.parse(body)
      
      const settings = settingsService.getSettings(userId)
      const commandIndex = settings.preferences.customCommands.findIndex(cmd => cmd.name === commandName)
      if (commandIndex === -1) {
        return c.json({ error: 'Command not found' }, 404)
      }
      
      const updatedCommands = [...settings.preferences.customCommands]
      updatedCommands[commandIndex] = {
        name: commandName,
        description: validated.description,
        promptTemplate: validated.promptTemplate,
        steps: validated.steps,
      }
      
      settingsService.updateSettings({
        customCommands: updatedCommands
      }, userId)
      
      return c.json(updatedCommands[commandIndex])
    } catch (error) {
      logger.error('Failed to update custom command:', error)
      if (error instanceof z.ZodError) {
        return c.json({ error: 'Invalid command data', details: error.issues }, 400)
      }
      return c.json({ error: 'Failed to update custom command' }, 500)
    }
  })

  app.delete('/custom-commands/:name', async (c) => {
    try {
      const userId = c.req.query('userId') || 'default'
      const commandName = decodeURIComponent(c.req.param('name'))
      
      const settings = settingsService.getSettings(userId)
      const commandExists = settings.preferences.customCommands.some(cmd => cmd.name === commandName)
      if (!commandExists) {
        return c.json({ error: 'Command not found' }, 404)
      }
      
      const updatedCommands = settings.preferences.customCommands.filter(cmd => cmd.name !== commandName)
      settingsService.updateSettings({
        customCommands: updatedCommands
      }, userId)
      
      return c.json({ success: true })
    } catch (error) {
      logger.error('Failed to delete custom command:', error)
      return c.json({ error: 'Failed to delete custom command' }, 500)
    }
  })

  return app
}
