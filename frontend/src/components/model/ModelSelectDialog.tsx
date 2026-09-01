import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Check } from "lucide-react";
import {
  getProvidersWithModels,
  formatModelName,
  formatProviderName,
} from "@/api/providers";
import { useSettings } from "@/hooks/useSettings";
import { useOpenCodeClient } from "@/hooks/useOpenCode";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import type { ProviderWithModels, Model } from "@/api/providers";
import { showToast } from "@/lib/toast";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

interface ModelSelectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opcodeUrl?: string | null;
  directory?: string;
  forDefault?: boolean;
}

export function ModelSelectDialog({
  open,
  onOpenChange,
  opcodeUrl,
  directory,
  forDefault = false,
}: ModelSelectDialogProps) {
  const [providers, setProviders] = useState<ProviderWithModels[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [useAsDefault, setUseAsDefault] = useState(false);
  const { preferences, updateSettings } = useSettings();
  const client = useOpenCodeClient(opcodeUrl);
  const queryClient = useQueryClient();
  const { sessionId } = useParams<{ sessionId: string }>();

  // 세션에서는 세션 모델을 현재 모델로 표시, 없으면 default fallback
  const sessionModelKey = ((): string | null => {
    if (!sessionId) return null;
    try {
      const data: any = queryClient.getQueryData(["opencode", "session", opcodeUrl, sessionId, directory]);
      if (data?.model?.providerID && data?.model?.id) return `${data.model.providerID}/${data.model.id}`;
    } catch {}
    return null;
  })();
  const currentModel = forDefault
    ? preferences?.defaultModel || ""
    : sessionId
      ? sessionModelKey || preferences?.defaultModel || ""
      : preferences?.defaultModel || "";

  const loadProviders = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getProvidersWithModels();
      setProviders(data);

      if (currentModel) {
        const [providerId] = currentModel.split("/");
        setSelectedProvider(providerId);
      }
    } catch {
      // Ignore errors when loading providers
    } finally {
      setLoading(false);
    }
  }, [opcodeUrl, currentModel]);

  useEffect(() => {
    if (open) {
      loadProviders();
      // 다이얼로그 열 때마다 "Use as default" 초기화
      setUseAsDefault(false);
    }
  }, [open, loadProviders]);

// Compute match rank for sorting: lower rank = better match
    const getModelMatchRank = (model: Model): number | null => {
      const queryLower = searchQuery.toLowerCase();
      if (model.name.toLowerCase().includes(queryLower)) return 0;
      if (model.id.toLowerCase().includes(queryLower)) return 1;
      return null;
    };

    const getProviderMatchRank = (provider: ProviderWithModels): number | null => {
      const queryLower = searchQuery.toLowerCase();
      if (provider.name.toLowerCase().includes(queryLower)) return 0;
      return null;
    };

    const filteredProviders = providers
      .map((provider) => {
        const providerRank = getProviderMatchRank(provider);
        const filteredModels = provider.models
          .map((model) => ({ model, rank: getModelMatchRank(model) }))
          .filter(({ rank }) => rank !== null || !searchQuery)
          .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
          .map(({ model }) => model);
        
        const bestModelRank = filteredModels.length > 0 
          ? getModelMatchRank(filteredModels[0]) 
          : null;
        
        const bestRank = providerRank !== null 
          ? Math.min(providerRank, bestModelRank ?? 999)
          : bestModelRank;

        return { provider, filteredModels, bestRank };
      })
      .filter(({ filteredModels, bestRank, provider }) => {
        const matchesSearch = !searchQuery || bestRank !== null;
        const matchesProvider = !selectedProvider || provider.id === selectedProvider;
        return matchesSearch && matchesProvider && filteredModels.length > 0;
      })
      .sort((a, b) => (a.bestRank ?? 999) - (b.bestRank ?? 999))
      .map(({ provider, filteredModels }) => ({ ...provider, models: filteredModels }));

  const handleModelSelect = async (providerId: string, modelId: string) => {
    const newModel = `${providerId}/${modelId}`;

    // 세션 전용: 기본은 세션에만 적용, 위에 "Use as default" 체크 시에만 전체(default)에도 적용
    if (sessionId && client && !forDefault) {
      const sessionKey = ["opencode", "session", opcodeUrl, sessionId, directory] as const;
      const sessionsKey = ["opencode", "sessions", opcodeUrl, directory] as const;
      // 낙천 업데이트: 현재 모델이 존재하지 않는(지원 중단된) 모델이어도
      // 클릭 즉시 컴포저 라벨이 바뀌게 한다. 실패하면 되돌리고 사유를 표시한다.
      const previous = queryClient.getQueryData(sessionKey);
      const previousSessions = queryClient.getQueryData(sessionsKey);
      queryClient.setQueryData(sessionKey, (old: unknown) => {
        if (!old || typeof old !== "object") return old;
        return { ...(old as Record<string, unknown>), model: { providerID: providerId, id: modelId } };
      });
      // 세션 목록의 모델 표시도 즉시 갱신
      queryClient.setQueryData(sessionsKey, (old: unknown) => {
        if (!Array.isArray(old)) return old;
        return (old as Array<Record<string, unknown>>).map((s) =>
          (s as { id?: string }).id === sessionId ? { ...s, model: { providerID: providerId, id: modelId } } : s
        );
      });
      try {
        await client.switchModel(sessionId, {
          id: modelId,
          providerID: providerId,
        });
        queryClient.invalidateQueries({
          queryKey: sessionKey,
        });
        queryClient.invalidateQueries({
          queryKey: sessionsKey,
        });
      } catch (error) {
        if (previous !== undefined) queryClient.setQueryData(sessionKey, previous);
        if (previousSessions !== undefined) queryClient.setQueryData(sessionsKey, previousSessions);
        showToast.error(
          `Failed to switch model: ${error instanceof Error ? error.message : "unknown error"}`,
          { duration: 6000 },
        );
        onOpenChange(false);
        return;
      }
      // 체크된 경우에만 전체(default)에도 적용
      if (useAsDefault) {
        updateSettings({ defaultModel: newModel });
      }
    } else {
      // 세션이 아니거나 forDefault=true인 경우: default만 갱신
      updateSettings({ defaultModel: newModel });
    }

    onOpenChange(false);
  };

  const handleProviderChange = (providerId: string) => {
    setSelectedProvider(providerId);
  };

  const getStatusBadge = (model: Model) => {
    if (model.experimental)
      return <Badge variant="secondary">Experimental</Badge>;
    if (model.status === "alpha")
      return <Badge variant="destructive">Alpha</Badge>;
    if (model.status === "beta") return <Badge variant="secondary">Beta</Badge>;
    return null;
  };

  const getModelCapabilities = (model: Model) => {
    const capabilities = [];
    if (model.reasoning) capabilities.push("Reasoning");
    if (model.tool_call) capabilities.push("Tools");
    if (model.attachment) capabilities.push("Files");
    return capabilities;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] bg-[#1a1a1a] border-[#333] text-white">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">
            Select Model
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Use as default — 세션에서만 노출, 체크 시에만 전체 적용 */}
          {sessionId && !forDefault && (
            <div className="flex items-center gap-2 px-1 py-1.5 rounded-md bg-[#0a0a0a] border border-[#333]">
              <Checkbox
                id="use-as-default"
                checked={useAsDefault}
                onCheckedChange={(v) => setUseAsDefault(v === true)}
                className="border-zinc-500 data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
              />
              <Label htmlFor="use-as-default" className="text-sm text-zinc-300 cursor-pointer flex-1">
                Use as default <span className="text-zinc-500">— also update default model for new sessions</span>
              </Label>
              {preferences?.defaultModel && (
                <span className="text-xs text-zinc-500 font-mono truncate max-w-[180px]">{preferences.defaultModel}</span>
              )}
            </div>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <Input
              placeholder="Search models or providers..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 bg-[#0a0a0a] border-[#333] text-white placeholder-zinc-500"
            />
          </div>

          {/* Provider Filter */}
          <div className="flex gap-2 flex-wrap">
            <Button
              variant={!selectedProvider ? "default" : "outline"}
              size="sm"
              onClick={() => handleProviderChange("")}
              className={
                !selectedProvider
                  ? "bg-blue-600 text-white"
                  : "bg-[#2a2a2a] border-[#333] text-zinc-300 hover:bg-[#333]"
              }
            >
              All Providers
            </Button>
            {providers.map((provider) => (
              <Button
                key={provider.id}
                variant={
                  selectedProvider === provider.id ? "default" : "outline"
                }
                size="sm"
                onClick={() => handleProviderChange(provider.id)}
                className={
                  selectedProvider === provider.id
                    ? "bg-blue-600 text-white"
                    : "bg-[#2a2a2a] border-[#333] text-zinc-300 hover:bg-[#333]"
                }
              >
                {formatProviderName(provider)}
              </Button>
            ))}
          </div>

          {/* Models List */}
          <div className="min-h-[300px] max-h-[400px] overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
              </div>
            ) : filteredProviders.length === 0 ? (
              <div className="text-center py-12 text-zinc-500">
                No providers or models found
              </div>
            ) : (
              <div className="space-y-4">
                {filteredProviders.map((provider) => (
                  <div key={provider.id} className="space-y-2">
                    <h3 className="font-medium text-zinc-200 flex items-center gap-2">
                      {formatProviderName(provider)}
                      {provider.api && (
                        <Badge variant="outline" className="text-xs">
                          API
                        </Badge>
                      )}
                    </h3>
                    <div className="grid gap-2 pl-4">
                      {provider.models.map((model) => {
                        const modelKey = `${provider.id}/${model.id}`;
                        const isSelected = currentModel === modelKey;
                        const capabilities = getModelCapabilities(model);

                        return (
                          <div
                            key={model.id}
                            className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                              isSelected
                                ? "bg-blue-600/20 border-blue-500"
                                : "bg-[#0a0a0a] border-[#333] hover:bg-[#1a1a1a] hover:border-[#444]"
                            }`}
                            onClick={() =>
                              handleModelSelect(provider.id, model.id)
                            }
                          >
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <h4 className="font-medium text-white">
                                    {formatModelName(model)}
                                  </h4>
                                  {isSelected && (
                                    <Check className="h-4 w-4 text-blue-400" />
                                  )}
                                  {getStatusBadge(model)}
                                </div>
                                <p className="text-sm text-zinc-400 mb-2">
                                  {model.id}
                                </p>

                                {/* Capabilities */}
                                {capabilities.length > 0 && (
                                  <div className="flex gap-1 flex-wrap mb-2">
                                    {capabilities.map((cap) => (
                                      <Badge
                                        key={cap}
                                        variant="secondary"
                                        className="text-xs"
                                      >
                                        {cap}
                                      </Badge>
                                    ))}
                                  </div>
                                )}

                                {/* Model Info */}
                                <div className="text-xs text-zinc-500 space-y-1">
                                  <div>
                                    Context:{" "}
                                    {model.limit?.context?.toLocaleString() ||
                                      "N/A"}{" "}
                                    tokens
                                  </div>
                                  <div>
                                    Output:{" "}
                                    {model.limit?.output?.toLocaleString() ||
                                      "N/A"}{" "}
                                    tokens
                                  </div>
                                  {model.cost && (
                                    <div>
                                      Cost: ${model.cost.input.toFixed(6)}
                                      /input, ${model.cost.output.toFixed(6)}
                                      /output
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Current Selection */}
          <div className="pt-4 border-t border-[#333] space-y-1">
            {sessionId && !forDefault ? (
              <>
                <p className="text-sm text-zinc-400">
                  Session model: <span className="text-white font-medium">{sessionModelKey || "— (uses default)"}</span>
                </p>
                <p className="text-sm text-zinc-400">
                  Default model: <span className="text-zinc-300 font-medium">{preferences?.defaultModel || "—"}</span>
                </p>
                {currentModel && (
                  <p className="text-xs text-zinc-500">Selected (highlighted): {currentModel}</p>
                )}
              </>
            ) : (
              currentModel && (
                <p className="text-sm text-zinc-400">
                  Current model: <span className="text-white font-medium">{currentModel}</span>
                </p>
              )
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

