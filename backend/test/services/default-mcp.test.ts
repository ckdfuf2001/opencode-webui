import { describe, it, expect } from 'vitest'
import { buildPlaywrightCommand } from '../../src/services/default-mcp'

describe('buildPlaywrightCommand', () => {
  it('pins bundled chromium when present', () => {
    expect(buildPlaywrightCommand('C:\\bundle\\chrome.exe')).toEqual([
      'npx',
      '--yes',
      '@playwright/mcp@latest',
      '--headless',
      '--isolated',
      '--executable-path',
      'C:\\bundle\\chrome.exe',
    ])
  })
  it('falls back to system resolution without bundled chromium', () => {
    expect(buildPlaywrightCommand('')).toEqual([
      'npx',
      '--yes',
      '@playwright/mcp@latest',
      '--headless',
      '--isolated',
    ])
  })
})
