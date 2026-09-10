import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, X, Trash2, ExternalLink, Plus, Pencil, ArrowLeft, Check, CircleX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  listHtmlPages,
  upsertHtmlPage,
  deleteHtmlPage,
  renameHtmlPage,
  type HtmlManagedPage,
} from '@/api/html-pages'
import { htmlViewUrl, isBrowserViewable, openHtmlInNewTab, codeDocument } from '@/lib/html-view'
import { getFileStat } from '@/api/files'
import { useFileSearch } from '@/hooks/useFileSearch'
import { showToast } from '@/lib/toast'

const CODE_TEMPLATE = `<html>\n<head>\n<meta charset="utf-8">\n<title>New page</title>\n</head>\n<body>\n<h1>Hello</h1>\n</body>\n</html>\n`

export function HtmlViewerMenu() {
  const queryClient = useQueryClient()
  const [menuOpen, setMenuOpen] = useState(false)
  const [creating, setCreating] = useState<null | { kind: 'file' | 'code' }>(null)
  const [draft, setDraft] = useState('')
  const [draftName, setDraftName] = useState('')
  const [draftExists, setDraftExists] = useState<boolean | null>(null)
  const [editing, setEditing] = useState<{ name: string | null; displayName: string; html: string } | null>(null)
  const [renaming, setRenaming] = useState<{ page: HtmlManagedPage; name: string } | null>(null)

  const { data: pages = [], isLoading } = useQuery({
    queryKey: ['html-pages'],
    queryFn: listHtmlPages,
    enabled: menuOpen,
    staleTime: 30 * 1000,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['html-pages'] })

  const { files: suggestions } = useFileSearch(draft, menuOpen && !!creating, '.')
  const viewableSuggestions = suggestions.filter(isBrowserViewable).slice(0, 6)

  useEffect(() => {
    const trimmed = draft.trim()
    if (!trimmed || !isBrowserViewable(trimmed)) {
      setDraftExists(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void getFileStat(trimmed)
        .then((stat) => { if (!cancelled) setDraftExists(stat.exists && !stat.isDirectory) })
        .catch(() => { if (!cancelled) setDraftExists(false) })
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [draft])

  const codeUrls = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of pages) {
      if (p.kind === 'code') {
        map.set(p.name, URL.createObjectURL(new Blob([codeDocument(p.html, p.name)], { type: 'text/html' })))
      }
    }
    return map
  }, [pages])

  useEffect(() => () => {
    codeUrls.forEach((url) => URL.revokeObjectURL(url))
  }, [codeUrls])

  const resetForms = () => {
    setCreating(null)
    setEditing(null)
    setDraft('')
    setDraftName('')
    setRenaming(null)
  }

  const openDirect = () => {
    const trimmed = draft.trim()
    if (!trimmed) return
    openHtmlInNewTab(trimmed, draftName)
  }

  const registerFile = async () => {
    const trimmed = draft.trim()
    if (!trimmed) return
    try {
      await upsertHtmlPage({ name: draftName.trim() || trimmed, kind: 'file', path: trimmed })
      showToast.success('관리 페이지에 등록했습니다')
      resetForms()
      invalidate()
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : '등록 실패')
    }
  }

  const saveCode = async () => {
    if (!editing) return
    try {
      await upsertHtmlPage({ name: editing.displayName, kind: 'code', html: editing.html })
      showToast.success('관리 페이지에 저장했습니다')
      resetForms()
      invalidate()
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : '저장 실패')
    }
  }

  const saveRename = async () => {
    if (!renaming || !renaming.name.trim()) return
    try {
      await renameHtmlPage(renaming.page.name, renaming.name.trim(), renaming.page)
      setRenaming(null)
      invalidate()
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : '이름 변경 실패')
    }
  }

  const handleDelete = async (page: HtmlManagedPage) => {
    try {
      await deleteHtmlPage(page.name)
      invalidate()
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : '삭제 실패')
    }
  }

  return (
    <>
      <button
        type="button"
        title="HTML viewer"
        onClick={() => { setMenuOpen((v) => !v); resetForms() }}
        className="fixed bottom-4 left-0 z-[60] w-10 h-10 rounded-r-full border border-l-0 border-border bg-card shadow-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-card-hover transition-all -translate-x-1/2 hover:translate-x-0"
      >
        <Globe className="w-5 h-5" />
      </button>
      {menuOpen && (
        <div className="fixed bottom-16 left-4 z-[60] w-[340px] max-w-[88vw] rounded-lg border border-border bg-card shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-xs font-semibold">HTML 뷰어</span>
            <div className="flex items-center gap-0.5">
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                title="새 페이지 (파일/소스)"
                onClick={() => { setCreating({ kind: 'file' }); setEditing(null); setDraft(''); setDraftName('') }}
              >
                <Plus className="w-3.5 h-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-6 w-6" title="Close" onClick={() => { setMenuOpen(false); resetForms() }}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

          {creating && (
            <div className="px-3 py-2 border-b border-border space-y-2">
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant={creating.kind === 'file' ? 'default' : 'outline'}
                  className="h-6 text-[11px] flex-1"
                  onClick={() => { setCreating({ kind: 'file' }); setEditing(null) }}
                >
                  파일명
                </Button>
                <Button
                  size="sm"
                  variant={creating.kind === 'code' ? 'default' : 'outline'}
                  className="h-6 text-[11px] flex-1"
                  onClick={() => { setCreating({ kind: 'code' }); setEditing({ name: null, displayName: `page-${pages.length + 1}.html`, html: CODE_TEMPLATE }) }}
                >
                  소스 입력
                </Button>
              </div>
              {creating.kind === 'file' && (
                <div className="space-y-1.5">
                  <Input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') openDirect() }}
                    placeholder="관리명 (비우면 파일명)"
                    className="h-7 text-xs"
                  />
                  <div className="flex items-center gap-1.5">
                    <div className="relative flex-1 min-w-0">
                      <Input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') openDirect() }}
                        placeholder="파일명 검색 또는 레포부터 경로 (aa/report.html)"
                        className="h-7 text-xs font-mono pr-7"
                        autoFocus
                      />
                      {draftExists === true && (
                        <Check className="w-3.5 h-3.5 absolute right-2 top-1/2 -translate-y-1/2 text-emerald-500" />
                      )}
                      {draftExists === false && (
                        <CircleX className="w-3.5 h-3.5 absolute right-2 top-1/2 -translate-y-1/2 text-destructive" />
                      )}
                    </div>
                    <Button size="sm" className="h-7 text-xs shrink-0" onClick={openDirect} disabled={draftExists === false}>열기</Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={registerFile} disabled={draftExists === false}>등록</Button>
                  </div>
                  {draft.trim() && (
                    <p className={`text-[11px] ${draftExists === false ? 'text-destructive' : draftExists ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                      {draftExists === false
                        ? '파일이 없습니다. 목록에서 선택하거나 경로를 확인하세요.'
                        : draftExists
                          ? `열기: ${draft.trim()}`
                          : '레포 폴더부터 입력하세요. 예: aa/report.html'}
                    </p>
                  )}
                  {viewableSuggestions.length > 0 && (
                    <div className="rounded border border-border overflow-hidden">
                      {viewableSuggestions.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => {
                            setDraft(s)
                            setDraftName((prev) => prev || s.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '')
                          }}
                          className="w-full text-left px-2 py-1 text-[11px] font-mono truncate hover:bg-muted/70"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {editing ? (
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border">
                <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" title="뒤로" onClick={() => setEditing(null)}>
                  <ArrowLeft className="w-3.5 h-3.5" />
                </Button>
                <Input
                  value={editing.displayName}
                  onChange={(e) => setEditing({ ...editing, displayName: e.target.value })}
                  placeholder="관리명"
                  className="h-7 text-xs font-mono"
                />
                <Button size="sm" className="h-7 text-xs shrink-0" onClick={saveCode}>저장</Button>
              </div>
              <Textarea
                value={editing.html}
                onChange={(e) => setEditing({ ...editing, html: e.target.value })}
                spellCheck={false}
                rows={12}
                className="font-mono text-xs rounded-none border-0 resize-none"
              />
            </div>
          ) : !creating && (
            <div className="max-h-[40vh] overflow-y-auto">
              {isLoading ? (
                <p className="px-3 py-4 text-xs text-muted-foreground text-center">불러오는 중...</p>
              ) : pages.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted-foreground text-center">
                  + 버튼으로 파일 연결 또는 소스 입력 페이지를 만드세요.
                  <br />
                  탐색기 파일의 ... 메뉴에서도 열 수 있습니다.
                </p>
              ) : (
                pages.map((p) => (
                  <div key={p.name} className="flex items-center gap-1 px-3 py-1.5 hover:bg-muted/50">
                    {renaming?.page.name === p.name ? (
                      <div className="flex-1 min-w-0 flex items-center gap-1">
                        <Input
                          value={renaming.name}
                          onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveRename()
                            if (e.key === 'Escape') setRenaming(null)
                          }}
                          className="h-6 text-xs"
                          autoFocus
                        />
                        <Button size="sm" className="h-6 text-[11px] shrink-0" onClick={() => void saveRename()}>저장</Button>
                      </div>
                    ) : (
                      <a
                        href={p.kind === 'file' ? htmlViewUrl(p.path, p.name) : codeUrls.get(p.name)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="새탭으로 열기 (우클릭 메뉴 가능)"
                        className="flex-1 min-w-0 flex items-center gap-1.5 text-left text-xs"
                      >
                        <ExternalLink className="w-3 h-3 shrink-0 text-muted-foreground" />
                        <span className="shrink-0 text-muted-foreground">{p.kind === 'code' ? '⌨' : '📄'}</span>
                        <span className="truncate font-medium">{p.name}</span>
                      </a>
                    )}
                    {!renaming && p.kind === 'code' && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 shrink-0"
                        title="소스 편집"
                        onClick={() => setEditing({ name: p.name, displayName: p.name, html: p.html })}
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                    )}
                    {!renaming && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 shrink-0"
                        title="관리명 변경"
                        onClick={() => setRenaming({ page: p, name: p.name })}
                      >
                        <span className="text-[10px] font-bold text-muted-foreground">Aa</span>
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0"
                      title="삭제"
                      onClick={() => void handleDelete(p)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}
