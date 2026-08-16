'use client'

import { useEffect, useRef, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Location {
  id: number
  name: string
}

interface DoctrineRef {
  doctrine_name: string
  fit_name: string
}

interface RecommendedItem {
  type_id: number
  name: string
  qty: number
  unit_price: number
  staging_sell_price: number
  profit_per_unit: number
  profit_pct: number | null
  total_profit: number
  needed: boolean
  doctrines: DoctrineRef[]
}

interface UnpricedItem {
  type_id: number
  name: string
  qty: number
  unit_price: number
}

interface UnknownItem {
  item_name: string
  qty: number
}

interface EvaluateResponse {
  location_name: string
  recommended: RecommendedItem[]
  unprofitable: RecommendedItem[]
  unpriced: UnpricedItem[]
  unknown: UnknownItem[]
  parse_errors: string[]
}

type SortKey = 'name' | 'qty' | 'unit_price' | 'staging_sell_price' | 'profit_per_unit' | 'profit_pct' | 'total_profit'

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

function profitCls(n: number | null): string {
  if (n == null) return 'text-muted'
  return n > 0 ? 'text-eve-green' : n < 0 ? 'text-eve-red' : 'text-muted'
}

function fmtPct(pct: number | null): string {
  return pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '—'
}

function sortValue(item: RecommendedItem, key: SortKey): number | string {
  switch (key) {
    case 'name':                return item.name
    case 'qty':                 return item.qty
    case 'unit_price':          return item.unit_price
    case 'staging_sell_price':  return item.staging_sell_price
    case 'profit_per_unit':     return item.profit_per_unit
    case 'profit_pct':          return item.profit_pct ?? -Infinity
    case 'total_profit':        return item.total_profit
  }
}

const PRICE_TYPES = [
  { value: 'buy'   as const, label: 'Jita buy'  },
  { value: 'sell'  as const, label: 'Jita sell' },
  { value: 'split' as const, label: 'Split'     },
]

const TD = 'px-3 py-2 align-middle'
const TH = 'px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider whitespace-nowrap'
const BTN_SM = 'px-3 py-1 text-[12px] border border-wire text-muted hover:text-primary hover:border-secondary rounded transition-colors'
const BTN_SM_PRIMARY = 'px-3 py-1 text-[12px] border border-accent text-accent hover:bg-accent hover:text-canvas rounded transition-colors disabled:opacity-40 disabled:pointer-events-none'

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

// ── Main component ────────────────────────────────────────────────────────────

export function BuybackClient() {
  const [step, setStep] = useState<'form' | 'results' | 'done'>('form')
  const [locations, setLocations] = useState<Location[]>([])
  const [text, setText] = useState('')
  const [locationId, setLocationId] = useState<number | ''>('')
  const [priceType, setPriceType] = useState<'buy' | 'sell' | 'split'>('sell')
  const [result, setResult] = useState<EvaluateResponse | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('total_profit')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [created, setCreated] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    fetch('/api/locations').then(r => r.ok ? r.json() : []).then(setLocations)
    textareaRef.current?.focus()
  }, [])

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir(key === 'name' ? 'asc' : 'desc') }
  }

  function toggleSelect(index: number) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(index) ? next.delete(index) : next.add(index)
      return next
    })
  }

  const allSelected = result != null && result.recommended.length > 0 && result.recommended.every((_, i) => selected.has(i))

  function toggleSelectAll() {
    if (!result) return
    setSelected(allSelected ? new Set() : new Set(result.recommended.map((_, i) => i)))
  }

  const sortedRecommended = result
    ? [...result.recommended].sort((a, b) => {
        const av = sortValue(a, sortKey)
        const bv = sortValue(b, sortKey)
        const cmp = av < bv ? -1 : av > bv ? 1 : 0
        return sortDir === 'asc' ? cmp : -cmp
      })
    : []

  async function handleEvaluate() {
    if (!text.trim() || !locationId) return
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/buyback/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), price_type: priceType, location_id: locationId }),
      })
      if (!res.ok) throw new Error((await res.json()).detail || 'Evaluation failed')
      setResult(await res.json())
      setSelected(new Set())
      setStep('results')
    } catch (e: any) {
      setError(e.message || 'Failed to evaluate')
    } finally {
      setLoading(false)
    }
  }

  async function handleAccept() {
    if (!result || !locationId) return
    const items = result.recommended
      .filter((_, i) => selected.has(i))
      .map(r => ({ type_id: r.type_id, item_name: r.name, qty: r.qty, unit_price: r.unit_price }))
    if (items.length === 0) return
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/buyback/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, location_id: locationId }),
      })
      if (!res.ok) throw new Error()
      setCreated((await res.json()).created)
      setStep('done')
    } catch {
      setError('Failed to save.')
    } finally {
      setLoading(false)
    }
  }

  function reset() {
    setText(''); setResult(null); setSelected(new Set()); setStep('form'); setError(null)
  }

  if (step === 'done') return (
    <div className="py-12 text-center space-y-2">
      <div className="text-[20px] text-eve-green font-mono">{created}</div>
      <div className="text-[13px] text-secondary">lot{created !== 1 ? 's' : ''} added to inventory</div>
      <button onClick={reset} className={`mt-4 ${BTN_SM_PRIMARY}`}>Evaluate another list</button>
    </div>
  )

  if (step === 'form') return (
    <div className="max-w-2xl space-y-4">
      {error && <p className="text-[12px] text-eve-red">{error}</p>}
      <p className="text-[12px] text-muted">
        In Janice, select all rows and copy. Paste the result below — the same format used for inventory import.<br />
        Expected columns: <span className="text-faint font-mono">Name · Qty · Volume · Buy price · Sell price</span>
      </p>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={e => setText(e.target.value)}
        rows={10}
        placeholder={"Nitrogen Fuel Block\t10\t5.00\t17010.00\t17960.00"}
        className="w-full bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary placeholder:text-faint focus:outline-none focus:border-accent resize-none"
      />
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-[11px] text-muted mb-1.5">Buyback location</label>
          <select
            value={locationId}
            onChange={e => setLocationId(e.target.value ? Number(e.target.value) : '')}
            className="w-full bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
          >
            <option value="">Select location…</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-muted mb-1.5">Price you pay</label>
          <div className="flex gap-1.5">
            {PRICE_TYPES.map(pt => (
              <button key={pt.value} onClick={() => setPriceType(pt.value)}
                      className={`px-2.5 py-1.5 text-[12px] rounded border transition-colors ${
                        priceType === pt.value
                          ? 'border-accent text-accent bg-accent/10'
                          : 'border-wire text-muted hover:text-secondary'
                      }`}>
                {pt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex justify-end">
        <button onClick={handleEvaluate} disabled={!text.trim() || !locationId || loading} className={BTN_SM_PRIMARY}>
          {loading ? 'Evaluating…' : 'Evaluate'}
        </button>
      </div>
    </div>
  )

  // step === 'results'
  if (!result) return null

  return (
    <div className="space-y-4">
      {error && <p className="text-[12px] text-eve-red">{error}</p>}
      <div className="flex items-center justify-between">
        <div className="text-[13px] text-primary">
          {result.location_name} · <span className="text-eve-green">{result.recommended.length} profitable</span>
          {result.unprofitable.length > 0 && <span className="text-muted"> · {result.unprofitable.length} unprofitable</span>}
          {result.unpriced.length > 0 && <span className="text-muted"> · {result.unpriced.length} unpriced</span>}
          {result.unknown.length > 0 && <span className="text-eve-red"> · {result.unknown.length} unknown</span>}
        </div>
        <button onClick={reset} className={BTN_SM}>← New paste</button>
      </div>

      {result.parse_errors.length > 0 && (
        <div className="space-y-0.5">
          {result.parse_errors.map((e, i) => <p key={i} className="text-[11px] text-eve-amber">{e}</p>)}
        </div>
      )}

      {result.recommended.length === 0 ? (
        <div className="bg-surface border border-wire rounded p-8 text-center text-muted text-[13px]">
          Nothing in this list is profitable at {result.location_name}'s current prices.
        </div>
      ) : (
        <div className="border border-wire rounded overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-surface-hi border-b border-wire">
              <tr>
                <th className={`${TH} w-8`}>
                  <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} aria-label="Select all" className="align-middle" />
                </th>
                <th className={`${TH} text-left`}>Item</th>
                <SortTh label="Qty" sortKey="qty" current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Pay/u" sortKey="unit_price" current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Local sell" sortKey="staging_sell_price" current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Profit/u" sortKey="profit_per_unit" current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Profit %/u" sortKey="profit_pct" current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Total profit" sortKey="total_profit" current={sortKey} dir={sortDir} onSort={handleSort} />
              </tr>
            </thead>
            <tbody className="divide-y divide-wire">
              {sortedRecommended.map((item, i) => (
                <tr key={i}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(i)} onChange={() => toggleSelect(i)} aria-label={`Select ${item.name}`} className="align-middle" />
                  </td>
                  <td className={TD}>
                    <span className="text-primary">{item.name}</span>
                    {item.needed && (
                      <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide border border-accent text-accent">needed</span>
                    )}
                  </td>
                  <td className={`${TD} text-right font-mono text-secondary`}>{item.qty.toLocaleString()}</td>
                  <td className={`${TD} text-right font-mono text-muted`}>{iska(item.unit_price)}</td>
                  <td className={`${TD} text-right font-mono text-muted`}>{iska(item.staging_sell_price)}</td>
                  <td className={`${TD} text-right font-mono ${profitCls(item.profit_per_unit)}`}>{iska(item.profit_per_unit)}</td>
                  <td className={`${TD} text-right font-mono ${profitCls(item.profit_per_unit)}`}>{fmtPct(item.profit_pct)}</td>
                  <td className={`${TD} text-right font-mono font-semibold ${profitCls(item.total_profit)}`}>{iska(item.total_profit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(result.unprofitable.length > 0 || result.unpriced.length > 0 || result.unknown.length > 0) && (
        <div className="space-y-3">
          {result.unprofitable.length > 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-muted hover:text-secondary">{result.unprofitable.length} unprofitable (skip these)</summary>
              <div className="mt-2 space-y-0.5 pl-3">
                {result.unprofitable.map((item, i) => (
                  <div key={i} className="flex items-center gap-3 text-faint">
                    <span className="flex-1 truncate">{item.name}</span>
                    <span className="font-mono">×{item.qty.toLocaleString()}</span>
                    <span className={`font-mono w-20 text-right ${profitCls(item.profit_per_unit)}`}>{iska(item.profit_per_unit)}/u</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {result.unpriced.length > 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-muted hover:text-secondary">{result.unpriced.length} no local price data</summary>
              <div className="mt-2 space-y-0.5 pl-3">
                {result.unpriced.map((item, i) => (
                  <div key={i} className="flex items-center gap-3 text-faint">
                    <span className="flex-1 truncate">{item.name}</span>
                    <span className="font-mono">×{item.qty.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {result.unknown.length > 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-eve-red hover:text-secondary">{result.unknown.length} unknown item{result.unknown.length !== 1 ? 's' : ''}</summary>
              <div className="mt-2 space-y-0.5 pl-3">
                {result.unknown.map((item, i) => (
                  <div key={i} className="flex items-center gap-3 text-faint">
                    <span className="flex-1 truncate">{item.item_name}</span>
                    <span className="font-mono">×{item.qty.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <button onClick={handleAccept} disabled={selected.size === 0 || loading} className={BTN_SM_PRIMARY}>
          {loading ? 'Saving…' : `Buy Selected (${selected.size}) → Add to Inventory`}
        </button>
      </div>
    </div>
  )
}
