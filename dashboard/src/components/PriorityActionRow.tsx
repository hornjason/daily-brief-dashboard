import { Zap } from 'lucide-react'

export default function PriorityActionRow({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-text-secondary truncate min-w-0">
      <Zap className="w-3 h-3 text-accent shrink-0" />
      <span className="truncate" title={text}>{text}</span>
    </div>
  )
}
