import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { API_BASE_URL } from '@/config'
import { toWsPath } from '@opencode-webui/shared'

export interface FileHit {
  /** 저장·전송·API용: workspace 기준 (`repoA/src/foo.ts`) */
  wsPath: string
  /** 화면 표시용: 레포 기준 (`src/foo.ts`) */
  display: string
}

export interface FileSearchResult {
  files: FileHit[]
  isLoading: boolean
  error: Error | null
}

export function useFileSearch(
  query: string,
  enabled: boolean = true,
  directory?: string,
  repoRoot?: string,
): FileSearchResult {
  const [debouncedQuery, setDebouncedQuery] = useState(query)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(timer)
  }, [query])

  const { data, isLoading, error } = useQuery({
    queryKey: ['file-search', directory, repoRoot ?? '', debouncedQuery],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (directory) {
        params.append('path', directory)
      }
      if (debouncedQuery) {
        params.append('query', debouncedQuery)
      }

      const response = await fetch(
        `${API_BASE_URL}/api/files/search?${params.toString()}`
      )

      if (!response.ok) throw new Error('File search failed')

      const data = await response.json()
      // 백엔드는 base(repo dir) 기준 repoRel로 반환 — 호출자가 아는 좌표로 wsPath화.
      const raw = (Array.isArray(data) ? data : []) as string[]
      return raw.map((repoRel) => ({
        wsPath: toWsPath(repoRel, repoRoot ?? ''),
        display: repoRel,
      })) as FileHit[]
    },
    enabled: enabled && !!directory,
    staleTime: 60000,
  })

  return {
    files: data || [],
    isLoading,
    error: error as Error | null
  }
}
