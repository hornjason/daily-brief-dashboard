export default function CompetitiveSignalBadge({ competitor, context }: { competitor: string; context?: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium border rounded bg-signal-competitive-bg border-signal-competitive text-signal-competitive" title={context}>
      {competitor}
    </span>
  )
}
