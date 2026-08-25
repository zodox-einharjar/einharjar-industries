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
  priced_via_reprocessing: boolean
}

interface UnpricedItem {
  type_id: number
  name: string
  qty: number
  unit_price: number
  priced_via_reprocessing: boolean
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

interface SourcingMaterial {
  type_id: number
  name: string
  location_id: number
  location_name: string
  qty_needed: number
  qty_covered: number
  projects: string[]
}

interface SourcingItemToBuy {
  type_id: number
  name: string
  unit_price: number
  qty: number
  line_cost: number
  channel: 'buyback' | 'local' | 'jita'
  location_id?: number
  location_name?: string
  contributes_to: string[]
}

interface SourcingUnmet {
  type_id: number
  name: string
  qty_needed: number
  qty_produced: number
  shortfall: number
  location_id: number
  location_name: string
}

interface ChannelSummary {
  total_cost: number
  best_alt_channel: 'buyback' | 'local' | 'jita' | null
  best_alt_cost: number | null
  isk_saved: number | null
}

const CHANNEL_LABEL: Record<string, string> = { buyback: 'buyback', local: 'local market', jita: 'Jita' }

interface ProjectSourcing {
  materials: SourcingMaterial[]
  items_to_buy: SourcingItemToBuy[]
  total_cost: number
  unmet: SourcingUnmet[]
  channel_summary: {
    buyback: ChannelSummary | null
    jita: ChannelSummary | null
    local: Record<string, ChannelSummary>
  }
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
  project_sourcing: ProjectSourcing
  ore_reprocessing_efficiency_pct: number
  ore_reprocessing_fee_pct: number
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

// ── Materials coverage table ────────────────────────────────────────────────────

function MaterialsCoverage({ materials }: { materials: SourcingMaterial[] }) {
  if (materials.length === 0) return null
  return (
    <div className="border border-wire rounded overflow-x-auto mb-4">
      <table className="w-full text-[12px]">
        <thead className="bg-surface-hi border-b border-wire">
          <tr>
            <th className={`${TH} text-left`}>Material</th>
            <th className={`${TH} text-left`}>Location</th>
            <th className={`${TH} text-right`}>Qty needed</th>
            <th className={`${TH} text-right`}>Qty covered</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-wire">
          {materials.map(m => {
            const short = m.qty_needed - m.qty_covered
            return (
              <tr key={`${m.location_id}-${m.type_id}`}>
                <td className={TD}>
                  <span className="text-primary">{m.name}</span>
                  <span className="block text-[10px] text-faint">{m.projects.join(', ')}</span>
                </td>
                <td className={`${TD} text-secondary`}>{m.location_name}</td>
                <td className={`${TD} text-right font-mono text-secondary`}>{m.qty_needed.toLocaleString()}</td>
                <td className={`${TD} text-right font-mono font-semibold ${short > 0 ? 'text-eve-amber' : 'text-eve-green'}`}>
                  {m.qty_covered.toLocaleString()}
                  {short > 0 && <span className="block text-[10px] text-faint font-normal">short {short.toLocaleString()}</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function UnmetCallout({ unmet }: { unmet: SourcingUnmet[] }) {
  if (unmet.length === 0) return null
  return (
    <div className="border border-eve-amber/40 rounded p-3 mb-4 space-y-1">
      <p className="text-[12px] text-eve-amber font-semibold">
        {unmet.length} shortfall{unmet.length !== 1 ? 's' : ''} can't be fully covered by any combination of buyback, local, or Jita supply
      </p>
      {unmet.map((u, i) => (
        <div key={i} className="flex items-center gap-3 text-[11px] text-faint">
          <span className="flex-1">{u.name} @ {u.location_name}</span>
          <span className="font-mono">{u.qty_produced.toLocaleString()} / {u.qty_needed.toLocaleString()}</span>
          <span className="font-mono text-eve-amber">short {u.shortfall.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

// ── Shopping plan (3 lists built from the joint sourcing plan's purchase lines) ─

interface ShoppingLine {
  type_id: number
  name: string
  qty: number
  for_materials: string[]
}

function mergeLines(lines: ShoppingLine[]): ShoppingLine[] {
  const byType = new Map<number, ShoppingLine>()
  for (const l of lines) {
    const existing = byType.get(l.type_id)
    if (existing) {
      existing.qty += l.qty
      for (const m of l.for_materials) if (!existing.for_materials.includes(m)) existing.for_materials.push(m)
    } else {
      byType.set(l.type_id, { ...l, for_materials: [...l.for_materials] })
    }
  }
  return [...byType.values()].sort((a, b) => b.qty - a.qty)
}

function buildShoppingLists(items: SourcingItemToBuy[]) {
  const buyback: ShoppingLine[] = []
  const jita: ShoppingLine[] = []
  const localByLoc: Record<string, ShoppingLine[]> = {}

  for (const item of items) {
    const line: ShoppingLine = { type_id: item.type_id, name: item.name, qty: item.qty, for_materials: item.contributes_to }
    if (item.channel === 'buyback') buyback.push(line)
    else if (item.channel === 'jita') jita.push(line)
    else if (item.channel === 'local' && item.location_name) (localByLoc[item.location_name] ??= []).push(line)
  }

  const local: Record<string, ShoppingLine[]> = {}
  for (const [loc, ls] of Object.entries(localByLoc)) local[loc] = mergeLines(ls)

  return { buyback: mergeLines(buyback), jita: mergeLines(jita), local }
}

function ChannelTotals({ summary }: { summary: ChannelSummary | null | undefined }) {
  if (!summary) return null
  return (
    <div className="border-t border-wire pt-1.5 mt-1.5 space-y-0.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-faint">Total cost</span>
        <span className="font-mono text-primary font-semibold">{iska(summary.total_cost)}</span>
      </div>
      {summary.isk_saved != null && summary.best_alt_channel && (
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-faint">vs {CHANNEL_LABEL[summary.best_alt_channel]}</span>
          <span className={`font-mono ${summary.isk_saved >= 0 ? 'text-eve-green' : 'text-eve-red'}`}>
            {summary.isk_saved >= 0 ? '−' : '+'}{iska(Math.abs(summary.isk_saved))} {summary.isk_saved >= 0 ? 'saved' : 'more'}
          </span>
        </div>
      )}
    </div>
  )
}

function ShoppingListColumn({ title, lines, onCopy, copied, summary }: {
  title: string; lines: ShoppingLine[]; onCopy: () => void; copied: boolean; summary?: ChannelSummary | null
}) {
  return (
    <div className="flex-1 min-w-[220px] border border-wire rounded p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-primary font-semibold">{title}</span>
        {lines.length > 0 && (
          <button onClick={onCopy} className="text-[11px] text-muted hover:text-accent transition-colors">
            {copied ? '✓ Copied' : 'Copy list'}
          </button>
        )}
      </div>
      {lines.length === 0 ? (
        <p className="text-[11px] text-faint">Nothing here.</p>
      ) : (
        <div className="space-y-1">
          {lines.map(l => (
            <div key={l.type_id} className="flex items-start gap-2 text-[11px]">
              <span className="flex-1 text-secondary">
                {l.name}
                <span className="block text-[10px] text-faint">for {l.for_materials.join(', ')}</span>
              </span>
              <span className="font-mono text-muted">×{l.qty.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
      <ChannelTotals summary={summary} />
    </div>
  )
}

function ShoppingPlan({ items, channelSummary }: {
  items: SourcingItemToBuy[]
  channelSummary: ProjectSourcing['channel_summary']
}) {
  const { buyback, jita, local } = useMemo(() => buildShoppingLists(items), [items])
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  async function doCopy(key: string, lines: ShoppingLine[]) {
    await copyText(buildMultibuy(lines.map(l => ({ name: l.name, qty: l.qty }))))
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(k => (k === key ? null : k)), 1500)
  }

  const localLocations = Object.keys(local)
  if (buyback.length === 0 && jita.length === 0 && localLocations.length === 0) return null

  return (
    <div className="mb-4">
      <p className="text-[11px] text-faint mb-2">
        Jointly-solved cheapest combination of sources for every shortfall at once, split into
        three lists to act on — accept these from the buyback, buy these on the local market,
        and multibuy-and-haul these from Jita.
      </p>
      <div className="flex gap-3 flex-wrap">
        <ShoppingListColumn
          title="Get from Buyback"
          lines={buyback}
          onCopy={() => doCopy('buyback', buyback)}
          copied={copiedKey === 'buyback'}
          summary={channelSummary.buyback}
        />
        {localLocations.length === 0 ? (
          <ShoppingListColumn title="Buy Locally" lines={[]} onCopy={() => {}} copied={false} />
        ) : (
          localLocations.map(loc => (
            <ShoppingListColumn
              key={loc}
              summary={channelSummary.local[loc]}
              title={`Buy Locally · ${loc}`}
              lines={local[loc]}
              onCopy={() => doCopy(`local-${loc}`, local[loc])}
              copied={copiedKey === `local-${loc}`}
            />
          ))
        )}
        <ShoppingListColumn
          title="Buy & Import from Jita"
          lines={jita}
          onCopy={() => doCopy('jita', jita)}
          copied={copiedKey === 'jita'}
          summary={channelSummary.jita}
        />
      </div>
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

      {activeTab === 'project' && (
        <>
          <UnmetCallout unmet={result.project_sourcing.unmet} />
          <ShoppingPlan items={result.project_sourcing.items_to_buy} channelSummary={result.project_sourcing.channel_summary} />
          <MaterialsCoverage materials={result.project_sourcing.materials} />
        </>
      )}

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
                  <td className={`${TD} text-right font-mono text-muted`}>
                    {iska(item.unit_price)}
                    {item.priced_via_reprocessing && (
                      <span
                        className="ml-1 text-[10px] text-faint"
                        title={`Priced as reprocessed mineral value at ${result.ore_reprocessing_efficiency_pct.toFixed(2)}% efficiency minus a ${result.ore_reprocessing_fee_pct.toFixed(1)}% station fee, not this item's own market price`}
                      >
                        ⚙
                      </span>
                    )}
                  </td>
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
