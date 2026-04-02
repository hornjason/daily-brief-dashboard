import { useState, useRef, useEffect } from 'react'
import CopyButton from './CopyButton'

interface AccountCountPillProps {
  accountNumbers: string[]
}

export function AccountCountPill({ accountNumbers }: AccountCountPillProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  if (accountNumbers.length === 0) return null

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="px-2.5 py-1 text-xs bg-surface-hover border border-border rounded-full text-text-secondary hover:text-text-primary transition-colors"
        aria-label={`${accountNumbers.length} account number${accountNumbers.length !== 1 ? 's' : ''}`}
      >
        {accountNumbers.length} account{accountNumbers.length !== 1 ? 's' : ''}
      </button>
      {open && (
        <div className="absolute top-full mt-1 left-0 z-20 bg-surface border border-border rounded-xl shadow-lg p-3 min-w-[200px]">
          {accountNumbers.map((acct, i) => (
            <div key={i} className="flex items-center justify-between py-1">
              <span className="text-xs text-text-primary font-mono tabular-nums">{acct}</span>
              <CopyButton text={acct} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default AccountCountPill
