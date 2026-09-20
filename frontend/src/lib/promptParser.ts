import type { ContentPart, FileInfo } from '@/api/types'
import { normSlash } from '@opencode-webui/shared'

export const MENTION_PATTERN = /@(?:"([^"]*)"|'([^']*)'|(\S+))/g
export const MENTION_TRIGGER_PATTERN = /(^|\s)@"([^"]*)$/

export interface MentionTrigger {
  start: number
  end: number
  query: string
}

export function detectMentionTrigger(
  text: string,
  cursorPosition: number
): MentionTrigger | null {
  const textBeforeCursor = text.slice(0, cursorPosition)
  const match = textBeforeCursor.match(MENTION_TRIGGER_PATTERN)
  
  if (!match || match.index === undefined) return null
  
  const atIndex = match.index + match[1].length
  return {
    start: atIndex,
    end: cursorPosition,
    query: match[2]
  }
}

export function parsePromptToParts(
  rawInput: string,
  fileMap: Map<string, FileInfo>
): ContentPart[] {
  const parts: ContentPart[] = []
  let lastIndex = 0
  
  for (const match of rawInput.matchAll(MENTION_PATTERN)) {
    const matchIndex = match.index!
    
    if (matchIndex > lastIndex) {
      const textContent = rawInput.slice(lastIndex, matchIndex)
      if (textContent.trim()) {
        parts.push({ type: 'text', content: textContent })
      }
    }
    
    const mentionText = match[1] ?? match[2] ?? match[3]
    // 정확 매칭 1순위 → 소문자 매칭 2순위(레거시 폴백).
    // 무조건 소문자는 대소문자 구분 FS에서 Foo.ts/foo.ts를 충돌시킨다.
    const key = normSlash(mentionText)
    const file = fileMap.get(key) ?? fileMap.get(key.toLowerCase())
    
    if (file) {
      parts.push({
        type: 'file',
        path: file.path,
        name: file.name
      })
    } else {
      parts.push({ type: 'text', content: match[0] })
    }
    
    lastIndex = matchIndex + match[0].length
  }
  
  if (lastIndex < rawInput.length) {
    const textContent = rawInput.slice(lastIndex)
    if (textContent.trim()) {
      parts.push({ type: 'text', content: textContent })
    }
  }
  
  return parts.length > 0 ? parts : [{ type: 'text', content: '' }]
}

export function getFilename(path: string): string {
  return path.split('/').pop() || path
}

export function getDirectory(path: string): string {
  const parts = path.split('/')
  return parts.slice(0, -1).join('/') || '.'
}
