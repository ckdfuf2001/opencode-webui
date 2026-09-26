import { describe, it, expect, vi } from 'vitest'

// settings.ts 는 services/settings 를 통해 bun:sqlite 를 값 import 하므로
// vitest(node) 에선 로드되지 않는다. 그래서 라우트가 쓰는 순수 헬퍼만 분리해 검증한다
// (DB 경로 통합 테스트는 bun 런타임 대상).
vi.mock('../../src/services/settings', () => ({ SettingsService: class {} }))
vi.mock('../../src/services/default-mcp', () => ({
  writeActiveOpenCodeConfigFile: vi.fn(),
  setActiveOpenCodeConfigModel: vi.fn(),
}))
vi.mock('../../src/services/proxy', () => ({ patchOpenCodeConfig: vi.fn(async () => true) }))
vi.mock('../../src/services/auth', () => ({ AuthService: class {} }))
vi.mock('../../src/services/opencode-single-server', () => ({
  opencodeServerManager: { restart: vi.fn(async () => undefined), getUrl: () => 'http://test' },
}))
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { hasProviderChanged, UpsertProviderSchema } from '../../src/routes/settings'

describe('hasProviderChanged (opencode 재시작 트리거)', () => {
  it('추가/삭제/값 변경만 감지하고 키 순서는 무시한다', () => {
    expect(hasProviderChanged({}, { provider: { nvidia: { npm: 'x' } } })).toBe(true)
    expect(hasProviderChanged({ provider: { nvidia: {} } }, {})).toBe(true)
    expect(hasProviderChanged(
      { provider: { a: { npm: '1' }, b: { npm: '2' } } },
      { provider: { b: { npm: '2' }, a: { npm: '1' } } },
    )).toBe(false)
    expect(hasProviderChanged(
      { provider: { a: { baseURL: 'https://old/v1' } } },
      { provider: { a: { baseURL: 'https://new/v1' } } },
    )).toBe(true)
  })

  it('provider 가 없으면 false — MCP 만 바꾼 경우 재시작 대상이 아니다', () => {
    expect(hasProviderChanged({}, { mcp: { foo: {} } })).toBe(false)
  })
})

describe('UpsertProviderSchema (커스텀 provider 검증)', () => {
  const base = { npm: '@ai-sdk/openai-compatible', baseURL: 'https://integrate.api.nvidia.com/v1' }

  it('NVIDIA NIM 페이로드를 그대로 통과시킨다', () => {
    const r = UpsertProviderSchema.parse({
      id: 'nvidia',
      name: 'NVIDIA NIM',
      ...base,
      models: { 'nvidia/nemotron-3-super-120b-a12b': { name: 'Nemotron 3 Super' } },
    })
    expect(r.id).toBe('nvidia')
    expect(r.npm).toBe('@ai-sdk/openai-compatible')
    expect(r.models?.['nvidia/nemotron-3-super-120b-a12b']?.name).toBe('Nemotron 3 Super')
  })

  it('npm 은 기본값이 들어간다', () => {
    expect(UpsertProviderSchema.parse({ id: 'mine' }).npm).toBe('@ai-sdk/openai-compatible')
  })

  it('잘못된 provider id 를 거부한다 (대문자/공백/선행 기호)', () => {
    for (const id of ['NVIDIA', 'my provider', '-lead', '', 'a b']) {
      expect(UpsertProviderSchema.safeParse({ id, ...base }).success).toBe(false)
    }
  })

  it('baseURL 이 URL 이 아니면 거부한다', () => {
    expect(UpsertProviderSchema.safeParse({ id: 'x', baseURL: 'not-a-url' }).success).toBe(false)
  })

  it('빈 baseURL 은 미지정으로 통과시킨다 (openai 호환이 아닐 때)', () => {
    const r = UpsertProviderSchema.parse({ id: 'anthropic', npm: '@ai-sdk/anthropic', baseURL: '' })
    expect(r.baseURL).toBeUndefined()
  })
})
