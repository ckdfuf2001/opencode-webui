import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Loader2, Key, Check, X, Plus, Trash2 } from 'lucide-react'
import { providerCredentialsApi, getProviders, invalidateProvidersCache, type Provider } from '@/api/providers'
import { settingsApi } from '@/api/settings'
import { waitForOpencodeHealthy } from '@/lib/opencodeHealth'
import { showToast } from '@/lib/toast'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AddProviderDialog } from './AddProviderDialog'

interface RegistryProviderRecord {
  name?: string
  npm?: string
  options?: { baseURL?: string }
  models?: Record<string, unknown>
}

interface RegistryEntry {
  id: string
  name?: string
  npm?: string
  baseURL?: string
  modelCount: number
}

interface ProviderRegistry {
  entries: RegistryEntry[]
  /** config 의 disabled_providers — 제거된 기본 provider. 목록에서 숨긴다. */
  disabled: string[]
}

/** Settings 카드 한 장. opencode 카탈로그 항목과 레지스트리 전용 항목을 같은 형태로. */
interface ProviderRow {
  id: string
  name: string
  npm?: string
  baseURL?: string
  modelCount: number
  /** 우리가 config 에 등록한 provider (=제거 가능) */
  custom: boolean
}

export function ProviderSettings() {
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: providers, isLoading: providersLoading } = useQuery<Provider[]>({
    queryKey: ['providers'],
    queryFn: () => getProviders(),
    staleTime: 300000,
  })

  // 우리가 등록한 커스텀 provider 레지스트리(= opencode config 의 provider 레코드)
  // + 제거된 기본 provider 목록(config 의 disabled_providers).
  // opencode 의 /config/providers 는 내장 카탈로그만 돌려주므로 커스텀 provider 가
  // 거론 빠져 있다. 이 레지스트리를 병합해야 등록 직후에도 카드가 보이고 제거 버튼이 생긴다.
  const { data: registry } = useQuery<ProviderRegistry>({
    queryKey: ['opencode-config', 'custom-providers'],
    queryFn: async () => {
      const config = await settingsApi.getDefaultOpenCodeConfig()
      const provider = (config?.content?.provider as Record<string, RegistryProviderRecord> | undefined) || {}
      const disabled = Array.isArray(config?.content?.disabled_providers)
        ? (config.content.disabled_providers as string[])
        : []
      return {
        entries: Object.entries(provider).map(([id, entry]) => ({
          id,
          name: typeof entry?.name === 'string' ? entry.name : undefined,
          npm: typeof entry?.npm === 'string' ? entry.npm : undefined,
          baseURL: typeof entry?.options?.baseURL === 'string' ? entry.options.baseURL : undefined,
          modelCount: Object.keys(entry?.models ?? {}).length,
        })),
        disabled,
      }
    },
    staleTime: 30000,
  })
  const registryEntries = registry?.entries ?? []
  const disabledProviderIds = registry?.disabled ?? []

  // 표시 목록 = opencode 카탈로그 + 우리 레지스트리 병합, 제거된 provider 제외.
  const displayRows: ProviderRow[] = (() => {
    const hidden = new Set(disabledProviderIds)
    const catalog = providers ?? []
    const rows: ProviderRow[] = catalog
      .filter((p) => !hidden.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name || p.id,
        npm: p.npm,
        baseURL: typeof p.options?.baseURL === 'string' ? p.options.baseURL : undefined,
        modelCount: Object.keys(p.models || {}).length,
        custom: false,
      }))
    for (const entry of registryEntries) {
      if (hidden.has(entry.id)) continue
      const existing = rows.find((r) => r.id === entry.id)
      if (existing) {
        existing.custom = true
        continue
      }
      rows.push({
        id: entry.id,
        name: entry.name || entry.id,
        npm: entry.npm,
        baseURL: entry.baseURL,
        modelCount: entry.modelCount,
        custom: true,
      })
    }
    return rows
  })()

  const { data: credentialsList, isLoading: credentialsLoading } = useQuery({
    queryKey: ['provider-credentials'],
    queryFn: () => providerCredentialsApi.list(),
  })

  // 키 저장을 키 설정 다이얼로그 하나로 병합했다 — 값이 있으면 저장, 비어 있으면 삭제.
  // 별도 "Remove Key" 버튼을 두지 않는다 ( dialog 안에서 지우고 저장하면 지워진다 ).
  const saveCredentialMutation = useMutation({
    mutationFn: async ({ providerId, apiKey }: { providerId: string; apiKey: string }) => {
      const trimmed = apiKey.trim()
      if (trimmed) {
        await providerCredentialsApi.set(providerId, trimmed)
        return { removed: false as const }
      }
      await providerCredentialsApi.delete(providerId)
      return { removed: true as const }
    },
    onSuccess: (result, { providerId }) => {
      // 키를 넣으면 opencode 가 provider 를 인증 가능 상태로 보게 되므로 캐시 무효화.
      invalidateProvidersCache()
      queryClient.invalidateQueries({ queryKey: ['provider-credentials'] })
      queryClient.invalidateQueries({ queryKey: ['providers'] })
      queryClient.invalidateQueries({ queryKey: ['opencode-config'] })
      setSelectedProvider(null)
      setApiKey('')
      showToast.success(
        result.removed ? `API key removed for ${providerId}` : `API key saved for ${providerId}`,
      )
    },
    onError: (error) => {
      showToast.error(error instanceof Error ? error.message : 'Failed to save API key', { duration: 5000 })
    },
  })

  // provider 제거 — 커스텀은 config 레코드 삭제, 기본 제공분은 disabled_providers 로 숨김.
  const removeProviderMutation = useMutation({
    mutationFn: (providerId: string) => settingsApi.removeProvider(providerId),
    onSuccess: (result, providerId) => {
      invalidateProvidersCache()
      queryClient.invalidateQueries({ queryKey: ['providers'] })
      queryClient.invalidateQueries({ queryKey: ['provider-credentials'] })
      queryClient.invalidateQueries({ queryKey: ['opencode-config'] })
      setPendingRemoval(null)
      const verb = result?.mode === 'disabled' ? 'removed' : 'unregistered'
      showToast.success(
        result?.credentialsRemoved
          ? `Provider '${providerId}' ${verb} (API key removed) — waiting for OpenCode to restart…`
          : `Provider '${providerId}' ${verb} — waiting for OpenCode to restart…`,
      )
      // 제거도 opencode 재시동을 유발한다 — healthy 후 새로고침.
      void waitForOpencodeHealthy().then((ok) => {
        if (ok) window.location.reload()
        else showToast.warning('OpenCode did not come back — reload the page or restart OpenCode manually')
      })
    },
    onError: (error) => {
      showToast.error(error instanceof Error ? error.message : 'Failed to remove provider', { duration: 5000 })
      setPendingRemoval(null)
    },
  })

  // 다이얼로그를 열 때 저장된 키로 프리필한다 — 지우고 저장하면 삭제된다.
  const openKeyDialog = async (providerId: string) => {
    setSelectedProvider(providerId)
    setApiKey('')
    try {
      const existing = await providerCredentialsApi.get(providerId)
      if (existing) setApiKey(existing)
    } catch {
      // 조회 실패면 빈칸으로 연다 (fail-open — 없는 걸로 오인하지 않게 조용히)
    }
  }

  const handleSaveCredential = () => {
    if (!selectedProvider) return
    saveCredentialMutation.mutate({ providerId: selectedProvider, apiKey })
  }

  const handleRemoveProvider = (providerId: string, isCustom: boolean) => {
    const what = isCustom
      ? `Unregister provider '${providerId}'?`
      : `Remove provider '${providerId}'?`
    const detail = isCustom
      ? 'This removes it from the OpenCode config and deletes its stored API key.'
      : "This hides OpenCode's built-in provider and deletes its stored API key.\n"
        + 'To bring it back, remove its id from "disabled_providers" in the OpenCode config tab.'
    if (confirm(`${what}\n\n${detail}\n\nSessions still using ${providerId}/* models will fail until you switch models.`)) {
      setPendingRemoval(providerId)
      removeProviderMutation.mutate(providerId)
    }
  }

  const hasCredentials = (providerId: string) => {
    return credentialsList?.includes(providerId) || false
  }

  // 다이얼로그가 "빈 값 저장 = 삭제" 를 알 수 있게 현재 키 존재 여부.
  const selectedProviderHasKey = selectedProvider ? hasCredentials(selectedProvider) : false

  // 섹션 셸은 즉시 렌더하고, 목록 영역만 인라인 로딩으로 채운다.
  const listLoading = providersLoading || credentialsLoading

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground mb-2">Provider Credentials</h2>
          <p className="text-sm text-muted-foreground">
            Manage API keys for AI providers. Keys are stored securely in your workspace.
          </p>
        </div>
        <Button onClick={() => setAddDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Provider
        </Button>
      </div>

      {listLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : displayRows.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground text-center">
              No providers configured. Add providers with the button above.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {displayRows.map((provider) => {
            const hasKey = hasCredentials(provider.id)

            return (
              <Card key={provider.id} className="bg-card border-border">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="text-base flex items-center gap-2">
                        {provider.name || provider.id}
                        {provider.custom && (
                          <Badge variant="outline" className="text-xs">
                            Custom
                          </Badge>
                        )}
                        {hasKey ? (
                          <Badge variant="default" className="bg-green-600 hover:bg-green-700">
                            <Check className="h-3 w-3 mr-1" />
                            Configured
                          </Badge>
                        ) : (
                          <Badge variant="secondary">
                            <X className="h-3 w-3 mr-1" />
                            No Key
                          </Badge>
                        )}
                      </CardTitle>
                      <CardDescription className="mt-1">
                        {provider.npm ? <span className="text-xs">Package: {provider.npm}</span> : null}
                        {provider.baseURL && (
                          <span className="text-xs block">{provider.baseURL}</span>
                        )}
                        {provider.modelCount > 0 && (
                          <span className="text-xs block">{provider.modelCount} model{provider.modelCount !== 1 ? 's' : ''}</span>
                        )}
                        {/* opencode 는 config 의 커스텀 provider 를 카탈로그에 올리지 않는다
                            (/config/providers 에 안 뜨는 게 정상). 그래서 카탈로그 미등재로
                            "로드 실패" 를 단정하면 키를 넣어도 문구가 사라지지 않는 오해를 만든다.
                            키가 없으면 안내만, 있으면 아무 말도 하지 않는다. */}
                        {provider.custom && !hasKey && (
                          <span className="text-xs block text-muted-foreground">
                            No API key yet — add one to use models from this provider
                          </span>
                        )}
                      </CardDescription>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant={hasKey ? 'outline' : 'default'}
                        onClick={() => void openKeyDialog(provider.id)}
                      >
                        <Key className="h-4 w-4 mr-1" />
                        {hasKey ? 'Update Key' : 'Add Key'}
                      </Button>
                      {/* 기본 제공분도 제거할 수 있게 전부 노출한다 (내부는 레코드 삭제 vs
                          disabled_providers 숨김으로 갈린다). 파괴 액션이라 평소엔 회색으로
                          두고 마우스를 올렸을 때만 빨강으로 물들인다 — 실수로 눌러 지우는 걸 막는다. */}
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-muted-foreground hover:text-white hover:bg-[#A64552] hover:border-[#A64552] dark:hover:bg-[#91343F] dark:hover:border-[#91343F]"
                        onClick={() => handleRemoveProvider(provider.id, provider.custom)}
                        disabled={removeProviderMutation.isPending && pendingRemoval === provider.id}
                        title={provider.custom
                          ? 'Unregister provider (removes config entry and stored key)'
                          : 'Remove built-in provider (hides it via disabled_providers and deletes stored key)'}
                      >
                        {removeProviderMutation.isPending && pendingRemoval === provider.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            )
          })}
        </div>
      )}

      <Dialog open={!!selectedProvider} onOpenChange={(open) => !open && setSelectedProvider(null)}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>API Key for {selectedProvider}</DialogTitle>
            <DialogDescription>
              Stored keys are loaded here so you can review or edit them.
              Clear the field and save to remove the stored key.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="apiKey">API Key</Label>
              <div className="relative">
                <Input
                  id="apiKey"
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="bg-background border-border pr-20"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-7"
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? 'Hide' : 'Show'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {apiKey.trim()
                  ? 'Save to overwrite the stored key.'
                  : selectedProviderHasKey
                    ? 'Empty — saving will delete the stored key.'
                    : 'No key stored yet.'}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedProvider(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveCredential}
              disabled={saveCredentialMutation.isPending || (!apiKey.trim() && !selectedProviderHasKey)}
              variant={!apiKey.trim() && selectedProviderHasKey ? 'destructive' : 'default'}
            >
              {saveCredentialMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {!apiKey.trim() && selectedProviderHasKey ? 'Remove Key' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddProviderDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
    </div>
  )
}
