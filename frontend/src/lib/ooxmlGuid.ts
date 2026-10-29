/**
 * OOXML GUID `{8-4-4-4-12}` (대문자).
 * crypto.randomUUID()는 secure context 전용이라 http에서는 undefined다.
 * getRandomValues는 비보안 컨텍스트에서도 동작하므로 UUIDv4를 직접 만든다.
 * (pptx/xlsx 코멘트 writer가 공유한다.)
 */
export const guid = (): string => {
  const h = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('')
  const v = `${h.slice(0, 12)}4${h.slice(13, 16)}${'89ab'[h.charCodeAt(16) % 4]}${h.slice(17)}`
  return `{${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}}`.toUpperCase()
}
