import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { API_BASE_URL } from '@/config'

export interface FileSearchResult {
  files: string[]
  isLoading: boolean
  error: Error | null
}

export function useFileSearch(
  query: string,
  enabled: boolean = true,
  directory?: string
): FileSearchResult {
  const [debouncedQuery, setDebouncedQuery] = useState(query)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(timer)
  }, [query])

  const { data, isLoading, error } = useQuery({
    queryKey: ['file-search', directory, debouncedQuery],
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
      return data as string[]
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
