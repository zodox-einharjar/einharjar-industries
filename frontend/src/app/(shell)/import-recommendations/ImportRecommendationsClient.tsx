'use client'

import Link from 'next/link'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DoctrineRef {
  doctrine_name: string
  fit_name: string
}

interface RecommendationItem {
  type_id: number
  name: string
  qty_shortfall: number
  qty_owned: number
  qty_to_buy: number
  velocity_daily: number
  low_velocity: boolean
  days_to_sell: number | null
  jita_unit_cost: number | null
  jita_qty_available: number
  jita_depth_insufficient: boolean
  freight_per_unit: number | null
  import_cost_per_unit: number | null
  staging_sell_price: number | null
  profit_per_unit: number | null
  total_profit: number | null
  doctrines: DoctrineRef[]
}

interface RecommendationGroup {
  location_id: number
  location_name: string
  total_investment: number
  total_profit: number
  total_m3: number
  items: RecommendationItem[]
}

interface ExcludedLocation {
  location_id: number
  location_name: string
  reason: string
}

interface RecommendationsResponse {
  generated_at: string | null
  excluded_locations: ExcludedLocation[]
  groups: RecommendationGroup[]
}

type SortKey =
  | 'name' | 'qty_to_buy' | 'jita_unit_cost' | 'freight_per_unit' | 'import_cost_per_unit'
  | 'staging_sell_price' | 'profit_per_unit' | 'profit_pct' | 'total_profit' | 'velocity_daily' | 'days_to_sell'

// ── Helpers ───────────────────────────────────────────────────────────────────

function iska(n: number | null | undefined): string {
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

function fmtSynced(iso: string | null): string {
  if (!iso) return 'never'
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return new Date(iso).toLocaleDateString()
}

function profitCls(n: number | null): string {
  if (n == null) return 'text-muted'
  return n > 0 ? 'text-eve-green' : n < 0 ? 'text-eve-red' : 'text-muted'
}

function profitPct(item: RecommendationItem): number | null {
  return item.profit_per_unit != null && item.import_cost_per_unit != null && item.import_cost_per_unit > 0
    ? item.profit_per_unit / item.import_cost_per_unit * 100
    : null
}

function fmtPct(pct: number | null): string {
  return pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '—'
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
  } else {
    const el = document.createElement('textarea')
    el.value = text
    el.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(el)
    el.focus(); el.select()
    document.execCommand('copy')
    document.body.removeChild(el)
  }
}

function buildMultibuy(items: { name: string; qty: number }[]): string {
  return items.map(i => `${i.name} x${i.qty}`).join('\n')
}

function sortValue(item: RecommendationItem, key: SortKey): number | string {
  switch (key) {
    case 'name':                  return item.name
    case 'qty_to_buy':            return item.qty_to_buy
    case 'jita_unit_cost':        return item.jita_unit_cost ?? -1
    case 'freight_per_unit':      return item.freight_per_unit ?? -1
    case 'import_cost_per_unit':  return item.import_cost_per_unit ?? -1
    case 'staging_sell_price':    return item.staging_sell_price ?? -1
    case 'profit_per_unit':       return item.profit_per_unit ?? -Infinity
    case 'profit_pct':            return profitPct(item) ?? -Infinity
    case 'total_profit':          return item.total_profit ?? -Infinity
    case 'velocity_daily':        return item.velocity_daily
    case 'days_to_sell':          return item.days_to_sell ?? Infinity
  }
}

const WINDOWS = [
  { label: '7d', days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
]

const TD = 'px-3 py-2 align-middle'
const TH = 'px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider whitespace-nowrap'

// ── Sortable column header ────────────────────────────────────────────────────

function SortTh({ label, sortKey, current, dir, onSort }: {
  label: string; sortKey: SortKey; current: SortKey; dir: 'asc' | 'desc'; onSort: (k: SortKey) => void
}) {
  const active = current === sortKey
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={`${TH} text-right cursor-pointer select-none hover:text-primary group`}
    >
      {label}
      <span className={`ml-1 ${active ? 'text-accent' : 'text-wire group-hover:text-faint'}`}>
        {active ? (dir === 'asc' ? '▲' : '▼') : '▲'}
      </span>
    </th>
  )
}

// ── Per-location group card ──────────────────────────────────────────────────

function GroupCard({ group }: { group: RecommendationGroup }) {
  const [sortKey, setSortKey] = useState<SortKey>('total_profit')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [copied, setCopied] = useState(false)

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir(key === 'name' ? 'asc' : 'desc') }
  }

  function toggleExpand(type_id: number) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(type_id) ? next.delete(type_id) : next.add(type_id)
      return next
    })
  }

  function toggleSelect(type_id: number) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(type_id) ? next.delete(type_id) : next.add(type_id)
      return next
    })
  }

  const buyable = group.items.filter(i => i.qty_to_buy > 0)
  const allSelected = buyable.length > 0 && buyable.every(i => selected.has(i.type_id))

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(buyable.map(i => i.type_id)))
  }

  const sorted = useMemo(() => {
    const list = [...group.items]
    list.sort((a, b) => {
      const av = sortValue(a, sortKey)
      const bv = sortValue(b, sortKey)
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
    return list
  }, [group.items, sortKey, sortDir])

  async function copyList() {
    const toCopy = selected.size > 0 ? buyable.filter(i => selected.has(i.type_id)) : buyable
    await copyText(buildMultibuy(toCopy.map(i => ({ name: i.name, qty: i.qty_to_buy }))))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="bg-surface border border-wire rounded p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <div className="text-[13px] font-medium text-primary">{group.location_name}</div>
          <div className="text-[11px] text-muted mt-0.5 font-mono">
            {iska(group.total_investment)} invest → <span className={profitCls(group.total_profit)}>{iska(group.total_profit)} profit</span>
            {' · '}{group.total_m3.toLocaleString(undefined, { maximumFractionDigits: 0 })} m³
          </div>
        </div>
        <button
          onClick={copyList}
          disabled={buyable.length === 0}
          className="px-3 py-1 text-[12px] border border-wire text-muted rounded hover:text-secondary transition-colors disabled:opacity-40 disabled:pointer-events-none"
        >
          {copied ? '✓ Copied' : selected.size > 0 ? `Copy Selected (${selected.size}) to Multibuy` : 'Copy All to Multibuy'}
        </button>
      </div>

      <div className="rounded border border-wire overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-hi border-b border-wire">
            <tr>
              <th className={`${TH} w-8`}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  disabled={buyable.length === 0}
                  aria-label="Select all"
                  className="align-middle"
                />
              </th>
              <th className={`${TH} text-left`}>Item</th>
              <SortTh label="Qty" sortKey="qty_to_buy" current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortTh label="Jita/u" sortKey="jita_unit_cost" current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortTh label="Freight/u" sortKey="freight_per_unit" current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortTh label="Import/u" sortKey="import_cost_per_unit" current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortTh label="Staging" sortKey="staging_sell_price" current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortTh label="Profit/u" sortKey="profit_per_unit" current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortTh label="Profit %/u" sortKey="profit_pct" current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortTh label="Total profit" sortKey="total_profit" current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortTh label="Vel/d" sortKey="velocity_daily" current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortTh label="Days to sell" sortKey="days_to_sell" current={sortKey} dir={sortDir} onSort={handleSort} />
              <th className={`${TH} w-8`}></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-wire">
            {sorted.map(item => {
              const isExpanded = expanded.has(item.type_id)
              return (
                <Fragment key={item.type_id}>
                  <tr className={item.low_velocity ? 'opacity-50' : ''}>
                    <td className="px-3 py-2">
                      {item.qty_to_buy > 0 && (
                        <input
                          type="checkbox"
                          checked={selected.has(item.type_id)}
                          onChange={() => toggleSelect(item.type_id)}
                          aria-label={`Select ${item.name}`}
                          className="align-middle"
                        />
                      )}
                    </td>
                    <td className={TD}>
                      <Link href={`/market/${item.type_id}`} className="text-primary hover:text-accent transition-colors">
                        {item.name}
                      </Link>
                      {item.low_velocity && (
                        <span className="ml-1.5 text-[10px] text-faint uppercase">no sales data</span>
                      )}
                      {item.jita_depth_insufficient && (
                        <span className="ml-1.5 text-[10px] text-eve-amber uppercase">thin Jita depth</span>
                      )}
                    </td>
                    <td className={`${TD} text-right font-mono text-secondary`}>{item.qty_to_buy.toLocaleString()}</td>
                    <td className={`${TD} text-right font-mono text-muted`}>{iska(item.jita_unit_cost)}</td>
                    <td className={`${TD} text-right font-mono text-muted`}>{iska(item.freight_per_unit)}</td>
                    <td className={`${TD} text-right font-mono text-muted`}>{iska(item.import_cost_per_unit)}</td>
                    <td className={`${TD} text-right font-mono text-muted`}>{iska(item.staging_sell_price)}</td>
                    <td className={`${TD} text-right font-mono ${profitCls(item.profit_per_unit)}`}>{iska(item.profit_per_unit)}</td>
                    <td className={`${TD} text-right font-mono ${profitCls(item.profit_per_unit)}`}>{fmtPct(profitPct(item))}</td>
                    <td className={`${TD} text-right font-mono font-semibold ${profitCls(item.total_profit)}`}>{iska(item.total_profit)}</td>
                    <td className={`${TD} text-right font-mono text-muted`}>{item.velocity_daily.toLocaleString()}</td>
                    <td className={`${TD} text-right font-mono text-muted`}>{item.days_to_sell != null ? `${item.days_to_sell}d` : '—'}</td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => toggleExpand(item.type_id)}
                        className="text-[11px] w-5 h-5 flex items-center justify-center text-muted hover:text-secondary transition-colors"
                        aria-label="Details"
                      >
                        {isExpanded ? '▲' : '▼'}
                      </button>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-canvas">
                      <td colSpan={13} className="px-4 py-2.5">
                        <div className="space-y-1 text-[11px]">
                          <div className="text-muted">
                            Jita depth: {item.jita_qty_available.toLocaleString()} available
                            {item.jita_depth_insufficient && (
                              <span className="text-eve-amber ml-1.5">— not enough to fill the recommended quantity</span>
                            )}
                          </div>
                          <div className="text-muted">
                            Owned: {item.qty_owned.toLocaleString()} · Total shortfall: {item.qty_shortfall.toLocaleString()}
                          </div>
                          {item.doctrines.map((d, i) => (
                            <div key={i} className="text-faint">{d.doctrine_name} / {d.fit_name}</div>
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
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function ImportRecommendationsClient() {
  const [data, setData] = useState<RecommendationsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [windowDays, setWindowDays] = useState(14)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`/api/import-recommendations?window_days=${windowDays}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(setData)
      .catch(() => setError('Failed to load import recommendations.'))
      .finally(() => setLoading(false))
  }, [windowDays])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-faint">Sell-through window:</span>
        {WINDOWS.map(w => (
          <button
            key={w.days}
            onClick={() => setWindowDays(w.days)}
            className={`px-3 py-1 text-[12px] rounded border transition-colors ${
              windowDays === w.days ? 'border-accent text-accent bg-accent/10' : 'border-wire text-muted hover:text-secondary'
            }`}
          >
            {w.label}
          </button>
        ))}
        {data?.generated_at && (
          <span className="text-[11px] text-faint ml-auto">Priced as of {fmtSynced(data.generated_at)}</span>
        )}
      </div>

      {loading ? (
        <div className="h-40 bg-surface border border-wire rounded animate-pulse" />
      ) : error ? (
        <div className="bg-surface border border-wire rounded p-8 text-center text-muted text-[13px]">{error}</div>
      ) : !data ? null : (
        <>
          {data.excluded_locations.length > 0 && (
            <div className="bg-eve-amber/10 border border-eve-amber/40 rounded px-4 py-2.5 text-[12px] text-eve-amber">
              No freight route configured for: {data.excluded_locations.map(l => l.location_name).join(', ')}
              {' — '}excluded until a route is added in Settings → Freight Routes.
            </div>
          )}

          {data.groups.length === 0 ? (
            <div className="bg-surface border border-wire rounded p-8 text-center text-muted text-[13px]">
              Nothing to import right now — all doctrine shortfalls are already covered, owned, or below the sell-through threshold.
            </div>
          ) : (
            <div className="space-y-4">
              {data.groups.map(g => <GroupCard key={g.location_id} group={g} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
