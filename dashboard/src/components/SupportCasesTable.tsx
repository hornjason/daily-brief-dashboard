import { useMemo } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
} from '@tanstack/react-table'
import { useState } from 'react'
import type { SupportCase } from '../types'
import { formatRelTime } from '../lib/format'
import { ArrowUpDown, ShieldAlert } from 'lucide-react'

const columnHelper = createColumnHelper<SupportCase>()

interface SupportCasesTableProps {
  cases: SupportCase[]
  loading: boolean
}

export function SupportCasesTable({ cases, loading }: SupportCasesTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'severity', desc: false },
    { id: 'daysOpen', desc: true },
  ])

  const columns = useMemo(
    () => [
      columnHelper.accessor('customerName', {
        header: 'Customer',
        cell: (info) => (
          <span className="text-text-primary font-medium">{info.getValue() ?? 'Unknown'}</span>
        ),
      }),
      columnHelper.accessor('caseNumber', {
        header: 'Case #',
        cell: (info) => (
          <span className="font-mono text-text-secondary text-xs">{info.getValue()}</span>
        ),
      }),
      columnHelper.accessor('severity', {
        header: 'Severity',
        cell: (info) => {
          const sev = info.getValue()
          const colorClass =
            sev === '1'
              ? 'bg-critical/20 text-critical'
              : sev === '2'
                ? 'bg-warning/20 text-warning'
                : sev === '3'
                  ? 'bg-yellow-500/20 text-yellow-400'
                  : 'bg-border text-text-secondary'
          return (
            <span className={`px-2 py-0.5 rounded text-xs font-bold font-mono ${colorClass}`}>
              Sev {sev}
            </span>
          )
        },
        sortingFn: (a, b) => {
          return parseInt(a.getValue('severity')) - parseInt(b.getValue('severity'))
        },
      }),
      columnHelper.accessor('summary', {
        header: 'Summary',
        cell: (info) => (
          <span className="text-text-primary text-sm truncate block max-w-xs">{info.getValue()}</span>
        ),
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        cell: (info) => {
          const status = info.getValue()
          const lower = status.toLowerCase()
          const colorClass = lower.includes('wait')
            ? 'bg-warning/15 text-warning border-warning/20'
            : lower.includes('progress')
              ? 'bg-accent/15 text-accent border-accent/20'
              : 'bg-border text-text-secondary border-border'
          return (
            <span className={`px-2 py-0.5 rounded text-xs border ${colorClass}`}>
              {status}
            </span>
          )
        },
      }),
      columnHelper.accessor('daysOpen', {
        header: 'Days Open',
        cell: (info) => {
          const days = info.getValue()
          const sev = info.row.original.severity
          const isOld = (sev === '1' && days > 3) || (sev === '2' && days > 7)
          return (
            <span className={`font-mono text-sm ${isOld ? 'text-critical font-bold' : 'text-text-secondary'}`}>
              {days}d
            </span>
          )
        },
      }),
    ],
    []
  )

  const table = useReactTable({
    data: cases,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-warning" />
          <h2 className="text-sm font-semibold text-text-primary">Support Cases</h2>
          <span className="text-xs text-text-secondary">
            {cases.length} open
          </span>
        </div>
      </div>

      {loading ? (
        <div className="p-5 space-y-2.5">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-10 bg-border/50 rounded animate-pulse-slow" />
          ))}
        </div>
      ) : cases.length === 0 ? (
        <div className="p-8 text-center">
          <p className="text-success text-sm">No open support cases</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b border-border">
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      className="px-4 py-3 text-left text-xs font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
                    >
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => {
                const sev = row.original.severity
                return (
                  <tr
                    key={row.id}
                    className={`border-b border-border/50 hover:bg-bg/50 transition-colors ${
                      sev === '1'
                        ? 'border-l-2 border-l-critical'
                        : sev === '2'
                          ? 'border-l-2 border-l-warning'
                          : ''
                    }`}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-4 py-3">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
