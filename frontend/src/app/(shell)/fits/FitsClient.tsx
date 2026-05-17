'use client'

import { useState, useEffect, useMemo } from 'react'
import Image from 'next/image'

type FitStatus = 'ready' | 'partial' | 'short' | 'unknown'

interface DoctrineSummary {
  doctrine_id: number
  doctrine_name: string
  df_id: number
  target_qty: number
  stock: number | null
  status: FitStatus
  location_name: string | null
  system: string | null
}

interface FitEntry {
  fit_id: number
  fit_name: string
  hull: string
  ship_type_id: number
  worst_status: FitStatus
  doctrines: DoctrineSummary[]
}

type SortKey = 'status' | 'name' | 'stock'

const STATUS_ORDER: Record<FitStatus, number> = { short: 0, partial: 1, unknown: 2, ready: 3 }
const STATUS_DOT: Record<FitStatus, string> = {
  ready: 'bg-eve-green', partial: 'bg-eve-amber', short: 'bg-eve-red', unknown: 'bg-muted',
}
const STATUS_TEXT: Record<FitStatus, string> = {
  ready: 'text-eve-green', partial: 'text-eve-amber', short: 'text-eve-red', unknown: 'text-muted',
}
const STATUS_LABEL: Record<FitStatus, string> = {
  ready: 'Ready', partial: 'Partial', short: 'Short', unknown: '—',
}

function stockBarColor(stock: number | null, target: number): string {
  if (stock === null) return 'bg-muted'
  const pct = target > 0 ? stock / target : 0
  if (pct >= 1.0) return 'bg-eve-green'
  if (pct >= 0.7) return 'bg-eve-amber'
  return 'bg-eve-red'
}

function stockTextColor(stock: number | null, target: number): string {
  if (stock === null) return 'text-muted'
  const pct = target > 0 ? stock / target : 0
  if (pct >= 1.0) return 'text-eve-green'
  if (pct >= 0.7) return 'text-eve-amber'
  return 'text-eve-red'
}

function FitCard({ fit }: { fit: FitEntry }) {
  const [expanded, setExpanded] = useState(false)
  const totalTarget = fit.doctrines.reduce((s, d) => s + d.target_qty, 0)

  return (
    <div className="rounded border border-wire overflow-hidden">
      <div
        className="flex items-center gap-3 px-3 py-2.5 bg-surface cursor-pointer select-none"
        onClick={() => setExpanded(e => !e)}
      >
        <Image
          src={`https://images.evetech.net/types/${fit.ship_type_id}/render?size=64`}
          alt={fit.hull}
          width={36}
          height={36}
          className="rounded flex-shrink-0 opacity-90"
          unoptimized
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[fit.worst_status]}`} />
            <span className="text-[13px] font-medium text-primary">{fit.fit_name}</span>
            <span className="text-[11px] text-muted">{fit.hull}</span>
          </div>
          <div className="text-[11px] text-faint mt-0.5">
            {fit.doctrines.length} doctrine{fit.doctrines.length !== 1 ? 's' : ''}
            {' · '}Total target: <span className="text-secondary font-mono">{totalTarget}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className={`text-[11px] font-medium ${STATUS_TEXT[fit.worst_status]}`}>
            {STATUS_LABEL[fit.worst_status]}
          </span>
          <button
            onClick={e => { e.stopPropagation(); setExpanded(v => !v) }}
            className="text-[11px] w-6 h-6 flex items-center justify-center border border-wire text-muted rounded hover:text-secondary transition-colors"
            aria-label="Toggle doctrines"
          >
            {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-wire bg-canvas overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-wire bg-surface-hi">
                <th className="text-left px-4 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider">Doctrine</th>
                <th className="text-left px-4 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider">Location</th>
                <th className="text-right px-4 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider">Stock / Target</th>
                <th className="px-4 py-2 w-28" />
              </tr>
            </thead>
            <tbody>
              {fit.doctrines.map(d => (
                <tr key={d.df_id} className="border-t border-wire">
                  <td className="px-4 py-2 text-primary">{d.doctrine_name}</td>
                  <td className="px-4 py-2 text-muted">{d.location_name ?? '—'}</td>
                  <td className="px-4 py-2 text-right">
                    <span className={`font-mono ${stockTextColor(d.stock, d.target_qty)}`}>
                      {d.stock ?? '—'}
                    </span>
                    <span className="font-mono text-muted"> / {d.target_qty}</span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="h-1.5 w-20 bg-wire rounded-full overflow-hidden ml-auto">
                      <div
                        className={`h-full rounded-full ${stockBarColor(d.stock, d.target_qty)}`}
                        style={{ width: `${Math.min((d.stock != null && d.target_qty > 0 ? d.stock / d.target_qty : 0) * 100, 100)}%` }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function FitsClient() {
  const [fits, setFits] = useState<FitEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('status')

  useEffect(() => {
    fetch('/api/fleet/fits')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(setFits)
      .catch(() => setError('Failed to load fits.'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    let result = fits
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(f =>
        f.fit_name.toLowerCase().includes(q) || f.hull.toLowerCase().includes(q)
      )
    }
    return [...result].sort((a, b) => {
      if (sortKey === 'name') return a.fit_name.localeCompare(b.fit_name)
      if (sortKey === 'status') {
        const diff = STATUS_ORDER[a.worst_status] - STATUS_ORDER[b.worst_status]
        return diff !== 0 ? diff : a.fit_name.localeCompare(b.fit_name)
      }
      // stock: lowest ratio first
      const totalA = a.doctrines.reduce((s, d) => s + d.target_qty, 0)
      const totalB = b.doctrines.reduce((s, d) => s + d.target_qty, 0)
      const ratioA = totalA > 0 ? a.doctrines.reduce((s, d) => s + (d.stock ?? 0), 0) / totalA : 1
      const ratioB = totalB > 0 ? b.doctrines.reduce((s, d) => s + (d.stock ?? 0), 0) / totalB : 1
      return ratioA - ratioB
    })
  }, [fits, search, sortKey])

  const stats = useMemo(() => ({
    total: fits.length,
    short: fits.filter(f => f.worst_status === 'short').length,
  }), [fits])

  if (loading) return <p className="text-muted text-[13px]">Loading…</p>
  if (error)   return <p className="text-eve-red text-[13px]">{error}</p>

  const SORT_OPTIONS: { key: SortKey; label: string }[] = [
    { key: 'status', label: 'Status' },
    { key: 'name',   label: 'Name' },
    { key: 'stock',  label: 'Stock' },
  ]

  return (
    <>
      <div className="flex items-start gap-3 mb-4 flex-wrap">
        <div className="bg-surface border border-wire rounded px-4 py-3 min-w-[120px]">
          <div className="text-[20px] font-bold font-mono leading-tight text-primary">{stats.total}</div>
          <div className="text-[11px] text-muted mt-0.5">Fits tracked</div>
        </div>
        <div className="bg-surface border border-wire rounded px-4 py-3 min-w-[120px]">
          <div className={`text-[20px] font-bold font-mono leading-tight ${stats.short > 0 ? 'text-eve-red' : 'text-primary'}`}>{stats.short}</div>
          <div className="text-[11px] text-muted mt-0.5">Short stock</div>
        </div>
        <div className="ml-auto self-center flex items-center gap-2 flex-shrink-0">
          <span className="text-[11px] text-faint">Sort:</span>
          {SORT_OPTIONS.map(o => (
            <button key={o.key} onClick={() => setSortKey(o.key)}
              className={[
                'text-[11px] px-2.5 py-1 rounded border transition-colors',
                sortKey === o.key ? 'border-accent text-accent' : 'border-wire text-muted hover:text-secondary',
              ].join(' ')}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search fit or ship…"
          className="bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary placeholder:text-faint focus:outline-none focus:border-accent transition-colors w-full"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded border border-wire px-4 py-12 text-center text-muted text-[13px]">
          {fits.length === 0
            ? 'No fits yet. Create a doctrine with fits on the Doctrines page.'
            : 'No fits match your search.'}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(fit => <FitCard key={fit.fit_id} fit={fit} />)}
        </div>
      )}
    </>
  )
}
