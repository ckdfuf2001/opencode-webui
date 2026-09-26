import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Loader2, ExternalLink } from 'lucide-react'
import { PROVIDER_TEMPLATES, type ProviderTemplate } from '@/lib/providerTemplates'
import { settingsApi } from '@/api/settings'
import { invalidateProvidersCache } from '@/api/providers'
import { waitForOpencodeHealthy } from '@/lib/opencodeHealth'
import { showToast } from '@/lib/toast'
import { useMutation, useQueryClient } from '@tanstack/react-query'

interface AddProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// opencode provider id 규칙과 동일 (백단 ProviderIdSchema).
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/

export function AddProviderDialog({ open, onOpenChange }: AddProviderDialogProps) {
  const [step, setStep] = useState<'select' | 'customize'>('select')
  const [selectedTemplate, setSelectedTemplate] = useState<ProviderTemplate | null>(null)
  const [providerId, setProviderId] = useState('')
  const [providerName, setProviderName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [npm, setNpm] = useState('@ai-sdk/openai-compatible')
  // 자유 입력 커스텀 지원: 템플릿에 없는 provider도 id/npm/baseURL/models로 직접 추가.
  const [showManual, setShowManual] = useState(false)
  const [modelDraft, setModelDraft] = useState('')
  const queryClient = useQueryClient()

  const idError = providerId && !PROVIDER_ID_RE.test(providerId)
    ? '소문자/숫자로 시작하고 소문자·숫자·. - _ 만 사용하세요'
    : null
  // baseURL이 비면 안 된다 — openai 호환 provider는 options.baseURL 없이는 못 탄다.
  const baseUrlRequired = npm === '@ai-sdk/openai-compatible'
  const baseUrlError = baseUrlRequired && !baseURL.trim()
    ? 'OpenAI 호환 provider는 Base URL이 필요합니다'
    : null

  const parsedModels = (): Record<string, { name: string }> | undefined => {
    const out: Record<string, { name: string }> = {}
    for (const raw of modelDraft.split(/[\n,]/)) {
      const line = raw.trim()
      if (!line) continue
      // 'model-id' 또는 'model-id | 표시명'
      const [id, label] = line.split('|').map((s) => s.trim())
      if (!id) continue
      out[id] = { name: label || id }
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  const addProviderMutation = useMutation({
    mutationFn: async () => {
      const manual = parsedModels()
      return settingsApi.upsertProvider({
        id: providerId.trim(),
        name: providerName.trim() || selectedTemplate?.name || undefined,
        npm: npm.trim() || '@ai-sdk/openai-compatible',
        baseURL: baseURL.trim() || undefined,
        // 수동 입력을 우선 — 템플릿 모델 목록은 덮어써야 사용자가 본 대로 반영된다.
        models: manual ?? selectedTemplate?.models,
      })
    },
    onSuccess: () => {
      // 5분 캐시를 안 비우면 새 provider가 '제공 중지된 모델'로 오인되어 5분간 막힌다.
      invalidateProvidersCache()
      queryClient.invalidateQueries({ queryKey: ['opencode-config'] })
      queryClient.invalidateQueries({ queryKey: ['providers'] })
      queryClient.invalidateQueries({ queryKey: ['provider-credentials'] })
      const id = providerId.trim()
      showToast.success(`Provider '${id}' registered — waiting for OpenCode to restart…`)
      handleClose()
      // provider 등록은 opencode 재시동을 유발한다. 재시동 중에 보내면 실패하고
      // 목록도 비어 보이므로, healthy 가 된 뒤 새로고침해 깨끗한 상태로 맞춘다.
      void waitForOpencodeHealthy().then((ok) => {
        if (ok) window.location.reload()
        else showToast.warning(`Provider '${id}' registered, but OpenCode did not come back — reload the page or restart OpenCode manually`)
      })
    },
    onError: (error) => {
      const msg = axiosErrorMessage(error)
      showToast.error(msg, { duration: 6000 })
    },
  })

  // mutation 선언 뒤에 계산한다 — 앞에서 참조하면 TDZ로 죽는다.
  const canAdd = !!providerId.trim() && !idError && !baseUrlError && !addProviderMutation.isPending

  const handleSelectTemplate = (template: ProviderTemplate) => {
    setSelectedTemplate(template)
    setProviderId(template.id)
    setProviderName(template.name)
    setBaseURL(template.options?.baseURL || '')
    setNpm(template.npm)
    // 'Custom OpenAI-Compatible' 가 진짜 커스텀 진입점이다 — npm/모델까지 직접
    // 편집할 수 있게 수동 모드로 연다 (템플릿 카드와 별도 카드를 두지 않는다).
    setShowManual(template.id === 'custom-openai-compatible')
    setModelDraft('')
    setStep('customize')
  }

  const handleAdd = () => {
    if (!canAdd) return
    addProviderMutation.mutate()
  }

  const handleClose = () => {
    setStep('select')
    setSelectedTemplate(null)
    setProviderId('')
    setProviderName('')
    setBaseURL('')
    setNpm('@ai-sdk/openai-compatible')
    setShowManual(false)
    setModelDraft('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[80vh] bg-card border-border overflow-y-auto">
        {step === 'select' && (
          <>
            <DialogHeader>
              <DialogTitle>Add Provider</DialogTitle>
              <DialogDescription>
                Choose a provider template, or enter any OpenAI-compatible endpoint yourself
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 py-4">
              {PROVIDER_TEMPLATES.map((template) => (
                <Card
                  key={template.id}
                  className="cursor-pointer hover:border-primary transition-colors bg-background border-border"
                  onClick={() => handleSelectTemplate(template)}
                >
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <CardTitle className="text-base flex items-center gap-2">
                          {template.name}
                          {!template.requiresApiKey && (
                            <Badge variant="secondary" className="text-xs">
                              Local
                            </Badge>
                          )}
                        </CardTitle>
                        <CardDescription className="text-sm mt-1">
                          {template.description}
                        </CardDescription>
                        <p className="text-xs text-muted-foreground mt-2">
                          {template.npm}
                        </p>
                      </div>
                    </div>
                  </CardHeader>
                </Card>
              ))}
            </div>
          </>
        )}

        {step === 'customize' && (
          <>
            <DialogHeader>
              <DialogTitle>Configure {selectedTemplate?.name || 'Custom Provider'}</DialogTitle>
              <DialogDescription>
                {selectedTemplate
                  ? 'Customize the provider settings before adding'
                  : 'Enter the endpoint details. OpenAI-compatible APIs just need a base URL.'}
                {selectedTemplate?.docsUrl && (
                  <a
                    href={selectedTemplate.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline ml-2"
                  >
                    View docs <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="providerId">Provider ID</Label>
                <Input
                  id="providerId"
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                  placeholder="e.g., nvidia, ollama, my-provider"
                  className="bg-background border-border"
                />
                <p className={`text-xs ${idError ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {idError || 'Unique identifier (lowercase, no spaces)'}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="providerName">Display Name</Label>
                <Input
                  id="providerName"
                  value={providerName}
                  onChange={(e) => setProviderName(e.target.value)}
                  placeholder={selectedTemplate?.name || 'My Provider'}
                  className="bg-background border-border"
                />
              </div>

              {showManual && (
                <div className="space-y-2">
                  <Label htmlFor="npm">NPM Package</Label>
                  <Input
                    id="npm"
                    value={npm}
                    onChange={(e) => setNpm(e.target.value)}
                    placeholder="@ai-sdk/openai-compatible"
                    className="bg-background border-border"
                  />
                  <p className="text-xs text-muted-foreground">
                    OpenAI-compatible endpoint는 @ai-sdk/openai-compatible 를 쓰세요
                  </p>
                </div>
              )}

              {(showManual || selectedTemplate?.options?.baseURL) && (
                <div className="space-y-2">
                  <Label htmlFor="baseURL">Base URL</Label>
                  <Input
                    id="baseURL"
                    value={baseURL}
                    onChange={(e) => setBaseURL(e.target.value)}
                    placeholder={selectedTemplate?.options?.baseURL || 'https://api.example.com/v1'}
                    className="bg-background border-border"
                  />
                  <p className={`text-xs ${baseUrlError ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {baseUrlError || 'API endpoint for this provider'}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="models">Models</Label>
                <Input
                  id="models"
                  value={modelDraft}
                  onChange={(e) => setModelDraft(e.target.value)}
                  placeholder="model-a | Display A, model-b"
                  className="bg-background border-border"
                  disabled={!showManual}
                />
                <p className="text-xs text-muted-foreground">
                  {showManual
                    ? '쉼표로 구분, 표시명은 "id | 이름". 비우면 서버가 목록을 그대로 사용합니다'
                    : selectedTemplate?.models
                      ? `${Object.keys(selectedTemplate.models).length}개 사전 설정됨 — 직접 입력하려면 Custom… 으로 추가하세요`
                      : '비우면 서버가 목록을 그대로 사용합니다'}
                </p>
              </div>

              <div className="bg-muted p-3 rounded-md">
                <p className="text-xs text-muted-foreground">
                  <strong>NPM Package:</strong> {npm}
                </p>
                {baseURL && (
                  <p className="text-xs text-muted-foreground mt-1">
                    <strong>Base URL:</strong> {baseURL}
                  </p>
                )}
                {!showManual && selectedTemplate?.models && (
                  <p className="text-xs text-muted-foreground mt-1">
                    <strong>Models:</strong> {Object.keys(selectedTemplate.models).length} pre-configured
                  </p>
                )}
              </div>

              {addProviderMutation.isError && (
                <p className="text-xs text-destructive">
                  {axiosErrorMessage(addProviderMutation.error)}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep('select')}>
                Back
              </Button>
              <Button onClick={handleAdd} disabled={!canAdd}>
                {addProviderMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Add Provider
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 백단 zod 에러(details)를 사람이 읽을 문장으로 바꾼다. */
function axiosErrorMessage(error: unknown): string {
  const e = error as { response?: { data?: { error?: string; details?: Array<{ message?: string }> } }; message?: string }
  const details = e?.response?.data?.details
  if (Array.isArray(details) && details.length > 0) {
    return details.map((d) => d?.message).filter(Boolean).join('; ') || 'Invalid provider data'
  }
  return e?.response?.data?.error || e?.message || 'Failed to register provider'
}
