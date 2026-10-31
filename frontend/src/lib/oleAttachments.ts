import JSZip from 'jszip'

export interface OleEmbeddingRef {
  partName: string
  relType: 'package' | 'oleObject'
  fallbackName: string
}

/**
 * C5-1: 원본 바이트에서 embeddings/ 파트를 찾는다.
 * - rels를 훑어 package/oleObject 구분을 읽는다 (없으면 확장자로 추정).
 * - 실패하면 빈 배열 (아이콘을 숨긴다, lib 렌더는 그대로).
 */
export async function listOleEmbeddings(data: ArrayBuffer | Uint8Array): Promise<OleEmbeddingRef[]> {
  try {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const zip = await JSZip.loadAsync(bytes)
    const embNames = Object.keys(zip.files).filter(
      (n) => n.includes('embeddings/') && !zip.files[n]!.dir,
    )
    if (embNames.length === 0) return []
    // rel 타입 맵: basename -> package | oleObject
    const relTypeByBase = new Map<string, 'package' | 'oleObject'>()
    const relNames = Object.keys(zip.files).filter((n) => n.endsWith('.rels') && !zip.files[n]!.dir)
    for (const rn of relNames) {
      let text = ''
      try {
        text = await zip.files[rn]!.async('string')
      } catch {
        continue
      }
      if (!text.includes('embeddings/')) continue
      // <Relationship Type=".../package|oleObject" Target="...embeddings/xxx" />
      const re =
        /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/(package|oleObject)"[^>]*Target="([^"]*embeddings\/[^"]*)"/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const kind = m[1] === 'package' ? 'package' : 'oleObject'
        const target = m[2] ?? ''
        const base = target.split('/').pop() ?? ''
        if (base && !relTypeByBase.has(base)) relTypeByBase.set(base, kind)
      }
    }
    return embNames.map((partName) => {
      const base = partName.split('/').pop() ?? 'attachment.bin'
      const fromRel = relTypeByBase.get(base)
      const relType = fromRel ?? (base.endsWith('.bin') ? 'oleObject' : 'package')
      return { partName, relType, fallbackName: base }
    })
  } catch {
    return []
  }
}

/** CFB 매직(D0 CF 11 E0) — oleObject 컨테이너 판정. */
export function looksLikeCfb(bytes: Uint8Array): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  )
}
