import { useState, useEffect, useRef } from "react"
import { ChevronDown, ChevronUp, Terminal, Copy } from "lucide-react"
import { API_BASE_URL } from "@/config"

async function fetchText(path: string): Promise<string> {
  const r = await fetch(`${API_BASE_URL}${path}`)
  if (!r.ok) return ""
  return r.text()
}

export function OutputPreview({ isStreaming }: { isStreaming?: boolean }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<"frontend" | "opencode">("frontend")
  const [text, setText] = useState("")
  const scrollRef = useRef<HTMLPreElement>(null)

  // auto-open while streaming so user sees progress without clicking
  useEffect(() => {
    if (isStreaming && !open) setOpen(true)
  }, [isStreaming]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const load = async () => {
      const t = await fetchText(tab === "frontend" ? "/api/logs?lines=120" : "/api/logs/opencode?lines=120")
      if (!cancelled) setText(t)
    }
    load()
    const id = setInterval(load, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [open, tab])

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [text, open])

  const copy = () => {
    navigator.clipboard.writeText(text).catch(() => {})
  }

  return (
    <div className="mx-4 mb-2 rounded-lg border border-border bg-card/60 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
      >
        <Terminal className="w-3.5 h-3.5" />
        <span>Output preview</span>
        {isStreaming && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />}
        <span className="ml-auto flex items-center gap-1">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </span>
      </button>
      {open && (
        <>
          <div className="flex items-center gap-1 px-3 py-1 border-y border-border bg-muted/30">
            {(["frontend", "opencode"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-2 py-0.5 rounded text-xs ${tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t === "frontend" ? "webui" : "opencode"}
              </button>
            ))}
            <button onClick={copy} className="ml-auto p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground" title="Copy">
              <Copy className="w-3 h-3" />
            </button>
          </div>
          <pre
            ref={scrollRef}
            className="max-h-64 overflow-auto p-3 text-xs font-mono whitespace-pre-wrap break-words bg-background/50"
          >
            {text || "(no logs yet)"}
          </pre>
        </>
      )}
    </div>
  )
}
