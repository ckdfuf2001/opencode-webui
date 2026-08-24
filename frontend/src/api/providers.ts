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
    const response = await axios.get(`${API_BASE_URL}/api/opencode/config/providers`, { timeout: 10_000 });
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

  // opencode(벤더 API)가 느리거나 실패해도, 자격증명이 등록된 프로바이더는 표시한다.
  const fromCredentials = await getProvidersFromCredentials();
  if (fromCredentials) return fromCredentials;

  return [];
}

async function getProvidersFromCredentials(): Promise<Provider[] | null> {
  try {
    const response = await axios.get(`${API_BASE_URL}/api/providers/credentials`, { timeout: 8_000 });
    const ids = (response.data?.providers ?? []) as string[];
    if (!ids.length) return null;
    return ids.map((id) => ({
      id,
      name: id,
      env: [],
      models: {},
    }));
  } catch {
    return null;
  }
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
