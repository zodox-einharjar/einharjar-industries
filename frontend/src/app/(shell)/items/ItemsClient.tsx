'use client'

import { useState, useEffect, useMemo, Fragment } from 'react'
import Image from 'next/image'

interface ItemFitRef {
  fit_id: number
  fit_name: string
  qty_per_fit: number
  target: number
}

interface ItemEntry {
  type_id: number
  name: string
  location_name: string
  system: string | null
  total_needed: number
  qty_available: number
  shortfall: number
  jita_price: number | null
  import_cost: number | null
  staging_price: number | null
  fits: ItemFitRef[]
}

type SortKey = 'name' | 'shortfall' | 'available' | 'price'

function iska(n: number | null): string {
  if (n == null) return '—'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  let val: number, suffix: string
  if (abs >= 1e9)      { val = n / 1e9; suffix = 'B' }
  else if (abs >= 1e6) { val = n / 1e6; suffix = 'M' }
  else if (abs >= 1e3) { val = n / 1e3; suffix = 'K' }
  else                 { return parseFloat(n.toPrecision(4)).toLocaleString() }
  return `${parseFloat(val.toPrecision(4))}${suffix}`
}

export function ItemsClient() {
  const [items, setItems] = useState<ItemEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('shortfall')
  const [sortAsc, setSortAsc] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch('/api/fleet/items')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(setItems)
      .catch(() => setError('Failed to load items.'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    let result = items
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(i => i.name.toLowerCase().includes(q))
    }
    return [...result].sort((a, b) => {
      let diff = 0
      if (sortKey === 'name')      diff = a.name.localeCompare(b.name)
      else if (sortKey === 'shortfall') diff = b.shortfall - a.shortfall
      else if (sortKey === 'available') diff = b.qty_available - a.qty_available
      else if (sortKey === 'price')     diff = (b.jita_price ?? 0) - (a.jita_price ?? 0)
      return sortAsc ? -diff : diff
    })
  }, [items, search, sortKey, sortAsc])

  const stats = useMemo(() => ({
    total: items.length,
    short: items.filter(i => i.shortfall > 0).length,
    shortfallIsk: items.reduce((s, i) => s + i.shortfall * (i.jita_price ?? 0), 0),
  }), [items])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(a => !a)
    else { setSortKey(key); setSortAsc(false) }
  }

  function arrow(key: SortKey) {
    if (sortKey !== key) return ''
    return sortAsc ? ' ▲' : ' ▼'
  }

  function toggleExpand(key: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  if (loading) return <p className="text-muted text-[13px]">Loading…</p>
  if (error)   return <p className="text-eve-red text-[13px]">{error}</p>

  const SORT_OPTIONS: { key: SortKey; label: string }[] = [
    { key: 'shortfall', label: 'Shortfall' },
    { key: 'name',      label: 'Name' },
    { key: 'available', label: 'In stock' },
    { key: 'price',     label: 'Jita price' },
  ]

  return (
    <>
      <div className="flex items-start gap-3 mb-4 flex-wrap">
        <div className="bg-surface border border-wire rounded px-4 py-3 min-w-[120px]">
          <div className="text-[20px] font-bold font-mono leading-tight text-primary">{stats.total}</div>
          <div className="text-[11px] text-muted mt-0.5">Unique items</div>
        </div>
        <div className="bg-surface border border-wire rounded px-4 py-3 min-w-[120px]">
          <div className={`text-[20px] font-bold font-mono leading-tight ${stats.short > 0 ? 'text-eve-red' : 'text-primary'}`}>{stats.short}</div>
          <div className="text-[11px] text-muted mt-0.5">Short stock</div>
        </div>
        <div className="bg-surface border border-wire rounded px-4 py-3 min-w-[130px]">
          <div className={`text-[20px] font-bold font-mono leading-tight ${stats.shortfallIsk > 0 ? 'text-eve-red' : 'text-primary'}`}>{iska(stats.shortfallIsk)}</div>
          <div className="text-[11px] text-muted mt-0.5">Shortfall (Jita)</div>
        </div>
        <div className="ml-auto self-center flex items-center gap-2 flex-shrink-0">
          <span className="text-[11px] text-faint">Sort:</span>
          {SORT_OPTIONS.map(o => (
            <button key={o.key} onClick={() => toggleSort(o.key)}
              className={[
                'text-[11px] px-2.5 py-1 rounded border transition-colors',
                sortKey === o.key ? 'border-accent text-accent' : 'border-wire text-muted hover:text-secondary',
              ].join(' ')}>
              {o.label}{arrow(o.key)}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search item…"
          className="bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary placeholder:text-faint focus:outline-none focus:border-accent transition-colors w-full"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded border border-wire px-4 py-12 text-center text-muted text-[13px]">
          {items.length === 0
            ? 'No items found. Add fits to your doctrines first.'
            : 'No items match your search.'}
        </div>
      ) : (
        <div className="rounded border border-wire overflow-hidden overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-wire bg-surface-hi">
                <th className="px-3 py-2 w-8" />
                <th className="text-left px-2 py-2">
                  <button onClick={() => toggleSort('name')}
                    className="text-[10px] font-semibold text-muted uppercase tracking-wider hover:text-primary transition-colors whitespace-nowrap">
                    Item{arrow('name')}
                  </button>
                </th>
                <th className="text-left px-4 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider whitespace-nowrap">Location</th>
                <th className="text-right px-4 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider whitespace-nowrap">Needed</th>
                <th className="text-right px-4 py-2">
                  <button onClick={() => toggleSort('available')}
                    className="text-[10px] font-semibold text-muted uppercase tracking-wider hover:text-primary transition-colors whitespace-nowrap">
                    In stock{arrow('available')}
                  </button>
                </th>
                <th className="text-right px-4 py-2">
                  <button onClick={() => toggleSort('shortfall')}
                    className="text-[10px] font-semibold text-muted uppercase tracking-wider hover:text-primary transition-colors whitespace-nowrap">
                    Shortfall{arrow('shortfall')}
                  </button>
                </th>
                <th className="text-right px-4 py-2">
                  <button onClick={() => toggleSort('price')}
                    className="text-[10px] font-semibold text-muted uppercase tracking-wider hover:text-primary transition-colors whitespace-nowrap">
                    Jita{arrow('price')}
                  </button>
                </th>
                <th className="text-right px-4 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider whitespace-nowrap">Import</th>
                <th className="px-3 py-2 w-8" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => {
                const short = item.shortfall > 0
                const rowKey = `${item.type_id}:${item.location_name}`
                const isExpanded = expanded.has(rowKey)
                return (
                  <Fragment key={rowKey}>
                    <tr className={`border-t border-wire ${short ? 'bg-eve-red/5' : ''}`}>
                      <td className="pl-3 pr-1 py-1.5">
                        <Image
                          src={`https://images.evetech.net/types/${item.type_id}/icon?size=32`}
                          alt=""
                          width={24}
                          height={24}
                          className="rounded-sm opacity-80"
                          unoptimized
                        />
                      </td>
                      <td className="px-2 py-1.5 text-primary">{item.name}</td>
                      <td className="px-4 py-1.5 text-muted whitespace-nowrap">{item.location_name}</td>
                      <td className="px-4 py-1.5 text-right font-mono text-muted">{item.total_needed.toLocaleString()}</td>
                      <td className={`px-4 py-1.5 text-right font-mono ${short ? 'text-eve-red' : 'text-secondary'}`}>
                        {item.qty_available.toLocaleString()}
                      </td>
                      <td className={`px-4 py-1.5 text-right font-mono font-semibold ${short ? 'text-eve-red' : 'text-muted'}`}>
                        {short ? item.shortfall.toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-1.5 text-right font-mono text-muted">{iska(item.jita_price)}</td>
                      <td className="px-4 py-1.5 text-right font-mono text-muted">{iska(item.import_cost)}</td>
                      <td className="px-3 py-1.5">
                        <button
                          onClick={() => toggleExpand(rowKey)}
                          className="text-[11px] w-5 h-5 flex items-center justify-center text-muted hover:text-secondary transition-colors"
                          aria-label="Show fits"
                        >
                          {isExpanded ? '▲' : '▼'}
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-t border-wire bg-canvas">
                        <td />
                        <td colSpan={8} className="px-4 py-2.5">
                          <div className="space-y-1">
                            {item.fits.map((f, i) => (
                              <div key={i} className="flex items-center gap-4 text-[11px]">
                                <span className="text-secondary font-medium w-48 truncate shrink-0">{f.fit_name}</span>
                                <span className="text-faint">
                                  {f.qty_per_fit} / fit × {f.target} target ={' '}
                                  <span className="text-muted font-mono">{(f.qty_per_fit * f.target).toLocaleString()}</span>
                                </span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
