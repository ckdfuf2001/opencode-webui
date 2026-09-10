import React from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
import { copyTextToClipboard } from '@/lib/clipboard'
import type { components } from '@/api/opencode-types'
import 'highlight.js/styles/github-dark.css'

type TextPart = components['schemas']['TextPart']

interface TextPartProps {
  part: TextPart
}

interface CodeBlockProps {
  children?: React.ReactNode
  className?: string
  [key: string]: unknown
}

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  const [copied, setCopied] = React.useState(false)
  
  const extractTextContent = (node: React.ReactNode): string => {
    if (typeof node === 'string') return node
    if (typeof node === 'number') return node.toString()
    if (Array.isArray(node)) return node.map(extractTextContent).join('')
    if (React.isValidElement(node)) {
      const element = node as React.ReactElement<any, any>
      if (element.props.children) {
        return extractTextContent(element.props.children as React.ReactNode)
      }
    }
    return ''
  }
  
  const codeContent = extractTextContent(children)
  
  const handleCopyCode = async () => {
    const ok = await copyTextToClipboard(codeContent)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      toast.error('코드 복사에 실패했습니다')
    }
  }

  return (
    <div className="relative">
      <pre className={`bg-accent p-1 rounded-lg overflow-x-auto border border-border my-4 ${className || ''}`} {...props}>
        {children}
      </pre>
      <button
        onClick={handleCopyCode}
        className="absolute top-2 right-2 p-1.5 rounded bg-card hover:bg-card-hover text-muted-foreground hover:text-foreground"
        title="Copy code"
      >
        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
      </button>
    </div>
  )
}

export function TextPart({ part }: TextPartProps) {
  // 렌더러 정의는 mount당 1회 고정한다. inline 정의는 매 렌더마다 새 컴포넌트
  // 타입이 되어 스트리밍 델타마다 마크다운 전체가 리마운트되고, 코드블록 복사
  // 버튼 상태·드래그 선택이 날아간다 ("카피가 제대로 안됨"의 원인).
  const components = React.useMemo<Components>(() => ({
    code({ className, children, ...props }) {
      const isInline = !className || !className.includes('language-')
      if (isInline) {
        return (
          <code className={className || "bg-accent px-1.5 py-0.5 rounded text-sm text-foreground"} {...props}>
            {children}
          </code>
        )
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    },
    pre({ children }) {
      return (
        <CodeBlock>
          {children}
        </CodeBlock>
      )
    },
    p({ children }) {
      return <p className="text-foreground my-0.5 md:my-1">{children}</p>
    },
    strong({ children }) {
      return <strong className="font-semibold text-foreground">{children}</strong>
    },
    ul({ children }) {
      return <ul className="list-disc text-foreground my-0.5 md:my-1">{children}</ul>
    },
    ol({ children }) {
      return <ol className="list-decimal text-foreground my-0.5 md:my-1">{children}</ol>
    },
    li({ children }) {
      return <li className="text-foreground my-0.5 md:my-1">{children}</li>
    },
    table({ children }) {
      return (
        <div className="my-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">{children}</table>
        </div>
      )
    },
    thead({ children }) {
      return <thead className="bg-muted/70">{children}</thead>
    },
    tbody({ children }) {
      return <tbody className="[&>tr:nth-child(even)]:bg-muted/30">{children}</tbody>
    },
    tr({ children }) {
      return <tr className="border-b border-border last:border-0">{children}</tr>
    },
    th({ children, style }) {
      return <th style={style} className="border-r border-border px-3 py-2 text-left font-semibold text-foreground last:border-r-0">{children}</th>
    },
    td({ children, style }) {
      return <td style={style} className="border-r border-border px-3 py-2 align-top text-foreground last:border-r-0">{children}</td>
    },
    a({ children, href }) {
      const isSessionLink = typeof href === 'string' && href.startsWith('?session=')
      if (isSessionLink) {
        const session = href!.slice('?session='.length)
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault()
              void copyTextToClipboard(session).then((ok) => {
                if (ok) toast.success(`Copied session: ${session}`)
                else toast.info(`Session: ${session}`)
              })
              // Also dispatch to fill chat input if present
              window.dispatchEvent(new CustomEvent('agent-browser:fill-session', { detail: session }))
            }}
            className="text-primary underline hover:text-primary/80 cursor-pointer"
          >
            {children}
          </a>
        )
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline hover:text-primary/80">{children}</a>
    }
  }), [])

  if (!part.text || part.text.trim() === '') {
    return (
      <div className="text-muted-foreground italic text-sm">
        [Empty message content]
      </div>
    )
  }

  return (
    <div className="prose prose-invert prose-enhanced max-w-none text-foreground overflow-hidden break-words leading-snug">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, rehypeRaw]}
        components={components}
      >
        {part.text}
      </ReactMarkdown>
    </div>
  )
}
