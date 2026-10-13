import type { ViewerTheme } from 'pptx-react-viewer'

/**
 * 앱 테마(index.css @theme)를 pptx 뷰어 토큰으로 매핑한다.
 * 필드는 전부 optional이라 우리 팔레트에 있는 것만 넘긴다.
 */
export function pptxThemeColors(isDark: boolean): ViewerTheme['colors'] {
  if (isDark) {
    return {
      background: '#0a0a0a',
      foreground: '#fafafa',
      card: '#141414',
      cardForeground: '#fafafa',
      popover: '#18181b',
      popoverForeground: '#fafafa',
      primary: '#185A8C',
      primaryForeground: '#fafafa',
      secondary: '#27272a',
      secondaryForeground: '#fafafa',
      muted: '#18181b',
      mutedForeground: '#d4d4d8',
      accent: '#27272a',
      accentForeground: '#fafafa',
      destructive: '#dc2626',
      destructiveForeground: '#fafafa',
      border: '#2a2a2a',
      input: '#27272a',
      ring: '#185A8C',
    }
  }
  return {
    background: '#ffffff',
    foreground: '#111827',
    card: '#f9fafb',
    cardForeground: '#111827',
    popover: '#ffffff',
    popoverForeground: '#111827',
    primary: '#185A8C',
    primaryForeground: '#ffffff',
    secondary: '#f4f4f5',
    secondaryForeground: '#111827',
    muted: '#f4f4f5',
    mutedForeground: '#6b7280',
    accent: '#f3f4f6',
    accentForeground: '#111827',
    destructive: '#dc2626',
    destructiveForeground: '#ffffff',
    border: '#e5e7eb',
    input: '#e5e7eb',
    ring: '#185A8C',
  }
}
