'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Location {
  id: number
  name: string
}

interface DoctrineRef {
  doctrine_name: string
  fit_name: string
}

interface NeededBy {
  doctrines: DoctrineRef[]
  projects: string[]
  want_qty: number | null
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
  velocity_daily: number
  low_velocity: boolean
  days_to_sell: number | null
  needed_by: NeededBy
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

interface UnmatchedWant {
  type_id: number
  name: string
  qty: number
}

interface SourcingCandidate {
  channel: string
  label: string
  unit_cost: number
  depth_insufficient: boolean
}

interface ProjectSourcingRow {
  type_id: number
  name: string
  location_id: number
  location_name: string
  qty_needed: number
  projects: string[]
  buyback_price: number | null
  local_price: number | null
  local_depth_insufficient: boolean
  jita_landed_price: number | null
  jita_depth_insufficient: boolean
  compressed_options: SourcingCandidate[]
  best: SourcingCandidate | null
  total_cost_at_best: number | null
}

interface EvaluateResponse {
  location_name: string
  recommended: RecommendedItem[]
  unprofitable: RecommendedItem[]
  unpriced: UnpricedItem[]
  unknown: UnknownItem[]
  parse_errors: string[]
  unmatched_wants: UnmatchedWant[]
  unknown_wants: string[]
  project_sourcing: ProjectSourcingRow[]
}

type SortKey =
  | 'name' | 'qty' | 'unit_price' | 'staging_sell_price' | 'profit_per_unit' | 'profit_pct'
  | 'total_profit' | 'velocity_daily' | 'days_to_sell'

type TabKey = 'doctrine' | 'project' | 'want' | 'market'

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

function niceMax(n: number): number {
  if (n <= 0) return 0
  const magnitude = 10 ** Math.floor(Math.log10(n))
  return Math.ceil(n / magnitude) * magnitude
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
    case 'velocity_daily':      return item.velocity_daily
    case 'days_to_sell':        return item.days_to_sell ?? Infinity
  }
}

function hasDoctrineNeed(r: RecommendedItem): boolean { return r.needed_by.doctrines.length > 0 }
function hasProjectNeed(r: RecommendedItem): boolean { return r.needed_by.projects.length > 0 }
function hasWantNeed(r: RecommendedItem): boolean { return r.needed_by.want_qty != null }
function hasAnyNeed(r: RecommendedItem): boolean {
  return hasDoctrineNeed(r) || hasProjectNeed(r) || hasWantNeed(r)
}

const TABS: { key: TabKey; label: string }[] = [
  { key: 'doctrine', label: 'Doctrine Needs' },
  { key: 'project', label: 'Project Needs' },
  { key: 'want', label: 'Personal Wants' },
  { key: 'market', label: 'Market Flips' },
]

function computeTabRows(resp: EvaluateResponse): Record<TabKey, RecommendedItem[]> {
  const allRows = [...resp.recommended, ...resp.unprofitable]
  return {
    doctrine: allRows.filter(hasDoctrineNeed),
    project: allRows.filter(hasProjectNeed),
    want: allRows.filter(hasWantNeed),
    market: resp.recommended.filter(r => !hasAnyNeed(r)),
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

// ── Need badges ────────────────────────────────────────────────────────────────

function NeedBadges({ nb }: { nb: NeededBy }) {
  const badges: { key: string; label: string; title: string }[] = []
  if (nb.doctrines.length) {
    badges.push({
      key: 'doctrine', label: 'doctrine',
      title: nb.doctrines.map(d => `Doctrine: ${d.doctrine_name} / ${d.fit_name}`).join('\n'),
    })
  }
  if (nb.projects.length) {
    badges.push({ key: 'project', label: 'project', title: nb.projects.map(p => `Project: ${p}`).join('\n') })
  }
  if (nb.want_qty != null) {
    badges.push({ key: 'want', label: 'wanted', title: `Personally wanted ×${nb.want_qty}` })
  }
  if (!badges.length) return null
  return (
    <>
      {badges.map(b => (
        <span
          key={b.key}
          title={b.title}
          className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide border border-accent text-accent"
        >
          {b.label}
        </span>
      ))}
    </>
  )
}

// ── Project sourcing panel ──────────────────────────────────────────────────────

function sourceCellCls(row: ProjectSourcingRow, channel: 'buyback' | 'local' | 'jita', insufficient: boolean): string {
  if (insufficient) return `${TD} text-right font-mono text-eve-amber`
  const isBest = row.best?.channel === channel
  return `${TD} text-right font-mono ${isBest ? 'text-eve-green font-semibold' : 'text-muted'}`
}

function SourcingPanel({ rows }: { rows: ProjectSourcingRow[] }) {
  if (rows.length === 0) return null
  return (
    <div className="border border-wire rounded overflow-x-auto mb-4">
      <table className="w-full text-[12px]">
        <thead className="bg-surface-hi border-b border-wire">
          <tr>
            <th className={`${TH} text-left`}>Material</th>
            <th className={`${TH} text-left`}>Location</th>
            <th className={`${TH} text-right`}>Qty needed</th>
            <th className={`${TH} text-right`}>Buyback</th>
            <th className={`${TH} text-right`}>Local</th>
            <th className={`${TH} text-right`}>Jita landed</th>
            <th className={`${TH} text-right`}>Best compressed</th>
            <th className={`${TH} text-right`}>Best source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-wire">
          {rows.map(r => {
            const bestCompressed = r.compressed_options.length
              ? r.compressed_options.reduce((a, b) => (a.unit_cost < b.unit_cost ? a : b))
              : null
            return (
              <tr key={`${r.location_id}-${r.type_id}`}>
                <td className={TD}>
                  <span className="text-primary">{r.name}</span>
                  <span className="block text-[10px] text-faint">{r.projects.join(', ')}</span>
                </td>
                <td className={`${TD} text-secondary`}>{r.location_name}</td>
                <td className={`${TD} text-right font-mono text-secondary`}>{r.qty_needed.toLocaleString()}</td>
                <td className={sourceCellCls(r, 'buyback', false)}>{iska(r.buyback_price)}</td>
                <td
                  className={sourceCellCls(r, 'local', r.local_depth_insufficient)}
                  title={r.local_depth_insufficient ? 'Not enough sell volume at this location to cover the full shortfall' : undefined}
                >
                  {iska(r.local_price)}
                </td>
                <td
                  className={sourceCellCls(r, 'jita', r.jita_depth_insufficient)}
                  title={r.jita_depth_insufficient ? 'Not enough sell volume in Jita to cover the full shortfall' : undefined}
                >
                  {iska(r.jita_landed_price)}
                </td>
                <td className={`${TD} text-right font-mono ${bestCompressed?.depth_insufficient ? 'text-eve-amber' : 'text-muted'}`}>
                  {bestCompressed ? `${iska(bestCompressed.unit_cost)}/u` : '—'}
                  {bestCompressed && <span className="block text-[10px] text-faint">{bestCompressed.label}</span>}
                </td>
                <td className={`${TD} text-right font-mono font-semibold ${r.best?.depth_insufficient ? 'text-eve-amber' : 'text-eve-green'}`}>
                  {r.best ? `${iska(r.best.unit_cost)}/u` : '—'}
                  {r.best && <span className="block text-[10px] text-faint font-normal">{r.best.label}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function ProcurementClient() {
  const [step, setStep] = useState<'form' | 'results'>('form')
  const [locations, setLocations] = useState<Location[]>([])
  const [text, setText] = useState('')
  const [wantListText, setWantListText] = useState('')
  const [locationId, setLocationId] = useState<number | ''>('')
  const [priceType, setPriceType] = useState<'buy' | 'sell' | 'split'>('sell')
  const [result, setResult] = useState<EvaluateResponse | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('market')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [sortKey, setSortKey] = useState<SortKey>('total_profit')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [minProfit, setMinProfit] = useState(0)
  const [minProfitPct, setMinProfitPct] = useState(0)
  const [minTotalProfit, setMinTotalProfit] = useState(0)
  const [copied, setCopied] = useState(false)
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

  function toggleSelect(type_id: number) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(type_id) ? next.delete(type_id) : next.add(type_id)
      return next
    })
  }

  const tabRows = useMemo(
    () => result ? computeTabRows(result) : { doctrine: [], project: [], want: [], market: [] },
    [result]
  )
  const activeRows = tabRows[activeTab]

  const maxProfit = useMemo(
    () => niceMax(Math.max(0, ...activeRows.map(i => i.profit_per_unit))),
    [activeRows]
  )
  const maxProfitPct = useMemo(
    () => niceMax(Math.max(0, ...activeRows.map(i => i.profit_pct ?? 0))),
    [activeRows]
  )
  const maxTotalProfit = useMemo(
    () => niceMax(Math.max(0, ...activeRows.map(i => i.total_profit))),
    [activeRows]
  )
  const filtersActive = minProfit > 0 || minProfitPct > 0 || minTotalProfit > 0

  const filteredRows = useMemo(() => activeRows.filter(i =>
    (minProfit <= 0 || i.profit_per_unit >= minProfit) &&
    (minProfitPct <= 0 || (i.profit_pct ?? -Infinity) >= minProfitPct) &&
    (minTotalProfit <= 0 || i.total_profit >= minTotalProfit)
  ), [activeRows, minProfit, minProfitPct, minTotalProfit])

  const allSelected = filteredRows.length > 0 && filteredRows.every(i => selected.has(i.type_id))

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(filteredRows.map(i => i.type_id)))
  }

  const sortedRows = [...filteredRows].sort((a, b) => {
    const av = sortValue(a, sortKey)
    const bv = sortValue(b, sortKey)
    const cmp = av < bv ? -1 : av > bv ? 1 : 0
    return sortDir === 'asc' ? cmp : -cmp
  })

  async function handleEvaluate() {
    if (!text.trim() || !locationId) return
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/procurement/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.trim(), price_type: priceType, location_id: locationId,
          want_list_text: wantListText.trim(),
        }),
      })
      if (!res.ok) throw new Error((await res.json()).detail || 'Evaluation failed')
      const data: EvaluateResponse = await res.json()
      setResult(data)
      setSelected(new Set())
      const tr = computeTabRows(data)
      setActiveTab(TABS.find(t => tr[t.key].length > 0)?.key ?? 'market')
      setStep('results')
    } catch (e: any) {
      setError(e.message || 'Failed to evaluate')
    } finally {
      setLoading(false)
    }
  }

  async function copyList() {
    if (!result) return
    const allRows = [...result.recommended, ...result.unprofitable]
    const items = allRows.filter(i => selected.has(i.type_id))
    if (items.length === 0) return
    await copyText(buildMultibuy(items.map(i => ({ name: i.name, qty: i.qty }))))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function reset() {
    setText(''); setWantListText(''); setResult(null); setSelected(new Set()); setStep('form'); setError(null)
    setMinProfit(0); setMinProfitPct(0); setMinTotalProfit(0)
  }

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
      <div>
        <label className="block text-[11px] text-muted mb-1.5">Items you personally need (optional)</label>
        <p className="text-[11px] text-faint mb-1.5">
          Name and quantity only, no price — flags these in the Personal Wants tab and notes anything
          you asked for that isn't currently being offered.
        </p>
        <textarea
          value={wantListText}
          onChange={e => setWantListText(e.target.value)}
          rows={4}
          placeholder={"Tritanium\t500000\nPyerite\t120000"}
          className="w-full bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary placeholder:text-faint focus:outline-none focus:border-accent resize-none"
        />
      </div>
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
        <button
          onClick={handleEvaluate}
          disabled={!text.trim() || !locationId || loading}
          className="px-3 py-1 text-[12px] border border-accent text-accent hover:bg-accent hover:text-canvas rounded transition-colors disabled:opacity-40 disabled:pointer-events-none"
        >
          {loading ? 'Evaluating…' : 'Evaluate'}
        </button>
      </div>
    </div>
  )

  // step === 'results'
  if (!result) return null

  const pureUnprofitable = result.unprofitable.filter(r => !hasAnyNeed(r))

  return (
    <div className="space-y-4">
      {error && <p className="text-[12px] text-eve-red">{error}</p>}
      <div className="flex items-center justify-between">
        <div className="text-[13px] text-primary">
          {result.location_name}
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

      <div className="flex gap-1.5 border-b border-wire">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-3 py-2 text-[12px] border-b-2 -mb-px transition-colors ${
              activeTab === t.key ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-secondary'
            }`}
          >
            {t.label} <span className="text-faint">({tabRows[t.key].length})</span>
          </button>
        ))}
      </div>

      {activeTab === 'project' && <SourcingPanel rows={result.project_sourcing} />}

      {activeRows.length > 0 && (
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-faint whitespace-nowrap">Min profit/u</span>
            <input
              type="range"
              min={0}
              max={maxProfit || 1}
              step={Math.max(1, maxProfit / 200)}
              value={Math.min(minProfit, maxProfit)}
              onChange={e => setMinProfit(Number(e.target.value))}
              className="accent-[color:var(--accent)] w-36"
            />
            <span className="text-[11px] text-muted font-mono w-16">{iska(minProfit)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-faint whitespace-nowrap">Min profit %/u</span>
            <input
              type="range"
              min={0}
              max={maxProfitPct || 1}
              step={Math.max(1, maxProfitPct / 200)}
              value={Math.min(minProfitPct, maxProfitPct)}
              onChange={e => setMinProfitPct(Number(e.target.value))}
              className="accent-[color:var(--accent)] w-36"
            />
            <span className="text-[11px] text-muted font-mono w-14">{minProfitPct.toFixed(0)}%</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-faint whitespace-nowrap">Min total profit</span>
            <input
              type="range"
              min={0}
              max={maxTotalProfit || 1}
              step={Math.max(1, maxTotalProfit / 200)}
              value={Math.min(minTotalProfit, maxTotalProfit)}
              onChange={e => setMinTotalProfit(Number(e.target.value))}
              className="accent-[color:var(--accent)] w-36"
            />
            <span className="text-[11px] text-muted font-mono w-16">{iska(minTotalProfit)}</span>
          </div>
          {filtersActive && (
            <button
              onClick={() => { setMinProfit(0); setMinProfitPct(0); setMinTotalProfit(0) }}
              className="text-[11px] text-muted hover:text-accent transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {activeRows.length === 0 ? (
        <div className="bg-surface border border-wire rounded p-8 text-center text-muted text-[13px]">
          Nothing here yet.
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="bg-surface border border-wire rounded p-8 text-center text-muted text-[13px]">
          No items match the current filters.
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
                <SortTh label="Vel/d" sortKey="velocity_daily" current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Days to sell" sortKey="days_to_sell" current={sortKey} dir={sortDir} onSort={handleSort} />
              </tr>
            </thead>
            <tbody className="divide-y divide-wire">
              {sortedRows.map(item => (
                <tr key={item.type_id} className={item.low_velocity ? 'opacity-50' : ''}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(item.type_id)} onChange={() => toggleSelect(item.type_id)} aria-label={`Select ${item.name}`} className="align-middle" />
                  </td>
                  <td className={TD}>
                    <span className="text-primary">{item.name}</span>
                    <NeedBadges nb={item.needed_by} />
                    {item.low_velocity && (
                      <span className="ml-1.5 text-[10px] text-faint uppercase">no sales data</span>
                    )}
                  </td>
                  <td className={`${TD} text-right font-mono text-secondary`}>{item.qty.toLocaleString()}</td>
                  <td className={`${TD} text-right font-mono text-muted`}>{iska(item.unit_price)}</td>
                  <td className={`${TD} text-right font-mono text-muted`}>{iska(item.staging_sell_price)}</td>
                  <td className={`${TD} text-right font-mono ${profitCls(item.profit_per_unit)}`}>{iska(item.profit_per_unit)}</td>
                  <td className={`${TD} text-right font-mono ${profitCls(item.profit_per_unit)}`}>{fmtPct(item.profit_pct)}</td>
                  <td className={`${TD} text-right font-mono font-semibold ${profitCls(item.total_profit)}`}>{iska(item.total_profit)}</td>
                  <td className={`${TD} text-right font-mono text-muted`}>{item.velocity_daily.toLocaleString()}</td>
                  <td className={`${TD} text-right font-mono text-muted`}>{item.days_to_sell != null ? `${item.days_to_sell}d` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'want' && (result.unmatched_wants.length > 0 || result.unknown_wants.length > 0) && (
        <div className="space-y-3">
          {result.unmatched_wants.length > 0 && (
            <details className="text-[12px]" open>
              <summary className="cursor-pointer text-eve-amber hover:text-secondary">
                {result.unmatched_wants.length} wanted item{result.unmatched_wants.length !== 1 ? 's' : ''} not currently offered
              </summary>
              <div className="mt-2 space-y-0.5 pl-3">
                {result.unmatched_wants.map((item, i) => (
                  <div key={i} className="flex items-center gap-3 text-faint">
                    <span className="flex-1 truncate">{item.name}</span>
                    <span className="font-mono">×{item.qty.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {result.unknown_wants.length > 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-eve-red hover:text-secondary">
                {result.unknown_wants.length} unresolved want-list line{result.unknown_wants.length !== 1 ? 's' : ''}
              </summary>
              <div className="mt-2 space-y-0.5 pl-3">
                {result.unknown_wants.map((line, i) => <div key={i} className="text-faint">{line}</div>)}
              </div>
            </details>
          )}
        </div>
      )}

      {(pureUnprofitable.length > 0 || result.unpriced.length > 0 || result.unknown.length > 0) && (
        <div className="space-y-3">
          {pureUnprofitable.length > 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-muted hover:text-secondary">{pureUnprofitable.length} unprofitable, not needed (skip these)</summary>
              <div className="mt-2 space-y-0.5 pl-3">
                {pureUnprofitable.map((item, i) => (
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

      <div className="flex justify-end gap-2">
        <button onClick={copyList} disabled={selected.size === 0} className={BTN_SM}>
          {copied ? '✓ Copied' : `Copy Selected (${selected.size}) to Multibuy`}
        </button>
      </div>
    </div>
  )
}
