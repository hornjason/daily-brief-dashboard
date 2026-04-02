import { Copy, Check } from 'lucide-react'
import { useState } from 'react'

interface CopyButtonProps {
  text: string
  variant?: 'inline' | 'button'
  className?: string
}

export default function CopyButton({ text, variant = 'inline', className = '' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  if (variant === 'button') {
    return (
      <button onClick={copy} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-badge text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors ${className}`} aria-label="Copy to clipboard">
        {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    )
  }
  return (
    <button onClick={copy} className={`p-1 rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors ${className}`} aria-label="Copy to clipboard">
      {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  )
}
