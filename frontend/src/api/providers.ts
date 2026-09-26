import axios from "axios";
import { API_BASE_URL } from "@/config";

export interface Model {
  id: string;
  name: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context: number;
    output: number;
  };
  modalities?: {
    input: ("text" | "audio" | "image" | "video" | "pdf")[];
    output: ("text" | "audio" | "image" | "video" | "pdf")[];
  };
  experimental?: boolean;
  status?: "alpha" | "beta";
  options?: Record<string, unknown>;
  provider?: {
    npm: string;
  };
}

export interface Provider {
  id: string;
  name: string;
  api?: string;
  env: string[];
  npm?: string;
  models: Record<string, Model>;
  options?: Record<string, unknown>;
}

export interface ProviderWithModels {
  id: string;
  name: string;
  api?: string;
  env: string[];
  npm?: string;
  models: Model[];
}

async function getProvidersFromOpenCode(): Promise<Provider[] | null> {
  try {
    const response = await axios.get(`${API_BASE_URL}/api/opencode/config/providers`);
    const data = response.data as { providers?: Provider[] };
    if (data?.providers?.length) {
      return data.providers.map((provider) => ({
        id: provider.id,
        name: provider.name ?? provider.id,
        api: provider.api,
        env: provider.env ?? [],
        npm: provider.npm,
        models: (provider.models ?? {}) as Record<string, Model>,
      }));
    }
  } catch (error) {
    console.warn("Failed to load OpenCode providers", error);
  }

  return null;
}

/**
 * opencode config 의 provider 레코드(우리가 등록한 커스텀 provider).
 * opencode 의 /config/providers 는 내장 카탈로그만 주므로 커스텀이 빠져 있다.
 * 모델 선택 목록과 resolveUsableModel 이 이걸 못 보면 커스텀 provider 가
 * "제공 중지된 모델" 로 판정돼 전송까지 막힌다.
 */
async function getCustomProvidersFromConfig(): Promise<Provider[]> {
  try {
    const { data } = await axios.get(
      `${API_BASE_URL}/api/settings/opencode-configs/default`,
    );
    const provider = (data?.content?.provider ?? {}) as Record<string, {
      name?: string;
      npm?: string;
      options?: { baseURL?: string };
      models?: Record<string, Omit<Model, "id">>;
    }>;
    return Object.entries(provider).map(([id, entry]) => ({
      id,
      name: entry?.name || id,
      npm: entry?.npm,
      env: [],
      models: (entry?.models ?? {}) as Record<string, Model>,
      options: entry?.options,
    }));
  } catch (error) {
    // 설정 조회 실패는 fail-open — opencode 카탈로그만으로 버틴다.
    console.warn("Failed to load custom providers from config", error);
    return [];
  }
}

export async function getProviders(): Promise<Provider[]> {
  const [fromOpenCode, custom] = await Promise.all([
    getProvidersFromOpenCode(),
    getCustomProvidersFromConfig(),
  ]);
  const base = fromOpenCode && fromOpenCode.length > 0 ? fromOpenCode : [];
  if (custom.length === 0) return base;

  // 카탈로그에 이미 있으면 합치지 않는다 (opencode 쪽 메타데이터를 신뢰).
  const seen = new Set(base.map((p) => p.id));
  return [...base, ...custom.filter((p) => !seen.has(p.id))];
}

export async function getProvidersWithModels(): Promise<ProviderWithModels[]> {
  const providers = await getProviders();

  const result = providers.map((provider) => {
    const models = Object.entries(provider.models || {}).map(([id, model]) => ({
      ...model,
      id: model.id || id,
      name: model.name || id,
    }));
    return {
      id: provider.id,
      name: provider.name,
      api: provider.api,
      env: provider.env || [],
      npm: provider.npm,
      models,
    };
  });

  return result;
}

export async function getModel(
  providerId: string,
  modelId: string,
): Promise<Model | null> {
  const providers = await getProvidersWithModels();
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return null;

  return provider.models.find((m) => m.id === modelId) || null;
}

export function formatModelName(model: Model): string {
  return model.name || model.id;
}

// 제공자 목록 캐시 (5분). 존재 확인용으로만 쓴다.
let providersCache: { at: number; list: ProviderWithModels[] } | null = null;
const PROVIDERS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * provider 추가/제거 직후엔 모듈 캐시를 즉시 버린다. 안 비우면 resolveUsableModel
 * 이 5분간 옛 목록으로 새 provider를 '제공 중지된 모델'로 판정해 기본값을 막는다.
 */
export function invalidateProvidersCache(): void {
  providersCache = null;
}

async function getCachedProviders(): Promise<ProviderWithModels[] | null> {
  if (providersCache && Date.now() - providersCache.at < PROVIDERS_CACHE_TTL_MS) {
    return providersCache.list;
  }
  try {
    const list = await getProvidersWithModels();
    providersCache = { at: Date.now(), list };
    return list;
  } catch {
    return providersCache?.list ?? null;
  }
}

export function modelExistsIn(list: ProviderWithModels[], modelKey: string): boolean {
  const slash = modelKey.indexOf('/');
  if (slash <= 0) return false;
  const provider = list.find((p) => p.id === modelKey.slice(0, slash));
  if (!provider) return false;
  return provider.models.some((m) => m.id === modelKey.slice(slash + 1));
}

/**
 * 후보 중 실제 제공되는 첫 모델을 고른다. 제공 중지된 기본값·세션값이
 * 전송을 망가뜨리는 것을 막는다. 목록을 모르면(fail-open) 첫 후보 그대로.
 */
export async function resolveUsableModel(candidates: (string | null | undefined)[]): Promise<{ model: string; skipped: string[] }> {
  const keys = candidates.filter((c): c is string => !!c && c.includes('/'));
  if (keys.length === 0) return { model: '', skipped: [] };
  const list = await getCachedProviders();
  if (!list || list.length === 0) return { model: keys[0]!, skipped: [] };
  const skipped: string[] = [];
  for (const k of keys) {
    if (modelExistsIn(list, k)) return { model: k, skipped };
    skipped.push(k);
  }
  return { model: '', skipped };
}

export function formatProviderName(
  provider: Provider | ProviderWithModels,
): string {
  return provider.name || provider.id;
}

export const providerCredentialsApi = {
  list: async (): Promise<string[]> => {
    const { data } = await axios.get(`${API_BASE_URL}/api/providers/credentials`);
    return data.providers;
  },

  getStatus: async (providerId: string): Promise<boolean> => {
    const { data } = await axios.get(
      `${API_BASE_URL}/api/providers/${providerId}/credentials/status`
    );
    return data.hasCredentials;
  },

  /** 저장된 키 값. 없으면 null. 키 설정 다이얼로그 프리필용. */
  get: async (providerId: string): Promise<string | null> => {
    const { data } = await axios.get(
      `${API_BASE_URL}/api/providers/${encodeURIComponent(providerId)}/credentials`
    );
    return data.apiKey ?? null;
  },
  set: async (providerId: string, apiKey: string): Promise<void> => {
    await axios.post(`${API_BASE_URL}/api/providers/${providerId}/credentials`, {
      apiKey,
    });
  },

  delete: async (providerId: string): Promise<void> => {
    await axios.delete(`${API_BASE_URL}/api/providers/${providerId}/credentials`);
  },
};

/**
 * provider 의 모델 목록을 서버에 물어본다 (custom provider 용).
 * 백엔드가 config 의 baseURL + 저장된 키로 GET {baseURL}/models 를 호출해
 * **config 에 models 로 저장까지** 한다. opencode 는 커스텀 provider 의 models
 * 선언이 있어야 모델을 알아서, 저장하지 않으면 목록엔 보여도 전송은
 * ProviderModelNotFoundError 로 실패한다.
 * 실패하면 빈 배열 — 그 provider 가 빠질 뿐이고 앱은 계속 동작한다.
 */
export async function fetchProviderModels(providerId: string): Promise<Model[]> {
  try {
    const { data } = await axios.post(
      `${API_BASE_URL}/api/settings/opencode-configs/default/providers/${encodeURIComponent(providerId)}/models/refresh`,
    );
    const count = typeof data?.count === 'number' ? data.count : 0;
    if (count === 0) return [];
    // 방금 config 에 저장했으므로 다시 읽어 실제 반영된 목록을 돌려준다.
    const providers = await getProviders();
    const provider = providers.find((p) => p.id === providerId);
    const models = provider?.models ?? {};
    return Object.entries(models).map(([id, m]) => ({ ...m, id: m?.id || id, name: m?.name || id }) as Model);
  } catch {
    return [];
  }
}
