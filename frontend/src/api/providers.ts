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

export async function getProviders(): Promise<Provider[]> {
  const fromOpenCode = await getProvidersFromOpenCode();
  if (fromOpenCode && fromOpenCode.length > 0) return fromOpenCode;

  return [];
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

  set: async (providerId: string, apiKey: string): Promise<void> => {
    await axios.post(`${API_BASE_URL}/api/providers/${providerId}/credentials`, {
      apiKey,
    });
  },

  delete: async (providerId: string): Promise<void> => {
    await axios.delete(`${API_BASE_URL}/api/providers/${providerId}/credentials`);
  },
};
