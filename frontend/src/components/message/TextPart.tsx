import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
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
    try {
      await navigator.clipboard.writeText(codeContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy code:', error)
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
        components={{
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
          a({ children, href }) {
            const isSessionLink = typeof href === 'string' && href.startsWith('?session=')
            if (isSessionLink) {
              const session = href!.slice('?session='.length)
              return (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault()
                    navigator.clipboard.writeText(session).then(() => {
                      toast.success(`Copied session: ${session}`)
                    }).catch(() => {
                      toast.info(`Session: ${session}`)
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
        }}
      >
        {part.text}
      </ReactMarkdown>
    </div>
  )
}
