'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type Mode = 'fill' | 'profit'
type PriceType = 'buy' | 'sell' | 'split'
type Source = 'jita' | 'buyback'

interface FitOption { doctrine_fit_id: number; fit_name: string; ship_name: string; target_qty: number }
interface DoctrineOption { doctrine_id: number; doctrine_name: string; fits: FitOption[] }
interface StagingOption { location_id: number; location_name: string; has_jita_route: boolean; doctrines: DoctrineOption[] }
interface OptionsResponse { staging: StagingOption[]; locations: { location_id: number; location_name: string }[] }

interface LadderLevel { source: Source; unit_price: number; qty: number; landed: number }

interface PlanRow {
  type_id: number
  name: string
  qty_needed: number
  qty_local: number
  qty_owned: number
  qty_wanted: number
  qty_to_buy: number
  depth: number
  unit_m3: number
  staging_price: number | null
  net_proceeds: number | null
  velocity_daily: number | null
  ladder: LadderLevel[]
  reason: 'no_supply' | 'no_sales' | 'no_local_price' | 'unprofitable' | null
  doctrines: { doctrine_name: string; fit_name: string }[]
}

interface PlanGroup {
  location_id: number
  location_name: string
  fee_pct: number
  freight_missing: boolean
  buyback_freight_missing: boolean
  items: PlanRow[]
  secondary: PlanRow[]
}

interface PlanResponse {
  generated_at: string | null
  mode: Mode
  groups: PlanGroup[]
  buyback_unused: string[]
  buyback_unknown: { item_name: string; qty: number }[]
  buyback_parse_errors: string[]
  buyback_count: number
}

interface Prefs { mode: Mode; fillPct: number; netInventory: boolean; windowDays: number }

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
  return items.filter(i => i.qty > 0).map(i => `${i.name} x${i.qty}`).join('\n')
}

function loadJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const s = localStorage.getItem(key)
    return s ? JSON.parse(s) as T : fallback
  } catch { return fallback }
}

function saveJson(key: string, value: unknown) {
  if (typeof window !== 'undefined') localStorage.setItem(key, JSON.stringify(value))
}

/** Price `qty` units against the ladder, cheapest landed cost first. */
function walkLadder(ladder: LadderLevel[], qty: number) {
  let remaining = qty, cost = 0, jita = 0, buyback = 0
  for (const l of ladder) {
    if (remaining <= 0) break
    const take = Math.min(remaining, l.qty)
    cost += take * l.landed
    if (l.source === 'jita') jita += take; else buyback += take
    remaining -= take
  }
  const filled = jita + buyback
  return { cost, jita, buyback, short: remaining, avg: filled > 0 ? cost / filled : null }
}

interface PricedRow {
  row: PlanRow
  key: string
  qty: number
  edited: boolean
  alloc: ReturnType<typeof walkLadder>
  profitPerUnit: number | null
  profitTotal: number | null
}

function priceRow(row: PlanRow, locationId: number, overrides: Record<string, number>): PricedRow {
  const key = `${locationId}:${row.type_id}`
  const edited = key in overrides
  const qty = edited ? overrides[key] : row.qty_to_buy
  const alloc = walkLadder(row.ladder, qty)
  const profitPerUnit = row.net_proceeds != null && alloc.avg != null ? row.net_proceeds - alloc.avg : null
  const filled = alloc.jita + alloc.buyback
  return { row, key, qty, edited, alloc, profitPerUnit, profitTotal: profitPerUnit != null ? profitPerUnit * filled : null }
}

const REASON_LABEL: Record<NonNullable<PlanRow['reason']>, string> = {
  no_supply: 'no supply',
  no_sales: 'no sales history',
  no_local_price: 'not on local market',
  unprofitable: 'unprofitable',
}

const WINDOWS = [7, 14, 30]
const PRICE_TYPES: { value: PriceType; label: string }[] = [
  { value: 'buy', label: 'Buy' }, { value: 'split', label: 'Split' }, { value: 'sell', label: 'Sell' },
]

const TD = 'px-3 py-2 align-middle'
const TH = 'px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider whitespace-nowrap'
const BTN = 'px-3 py-1 text-[12px] border border-wire text-muted rounded hover:text-secondary transition-colors disabled:opacity-40 disabled:pointer-events-none'
const chip = (on: boolean) => `px-3 py-1 text-[12px] rounded border transition-colors ${
  on ? 'border-accent text-accent bg-accent/10' : 'border-wire text-muted hover:text-secondary'
}`

function useCopied(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false)
  return [copied, async (text: string) => {
    await copyText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }]
}

function CopyButton({ label, text, disabled }: { label: string; text: string; disabled?: boolean }) {
  const [copied, copy] = useCopied()
  return (
    <button onClick={() => copy(text)} disabled={disabled || !text} className={BTN}>
      {copied ? '✓ Copied' : label}
    </button>
  )
}

// ── Scope picker ──────────────────────────────────────────────────────────────

function TriBox({ ids, off, onSet }: { ids: number[]; off: Set<number>; onSet: (ids: number[], on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const onCount = ids.filter(id => !off.has(id)).length
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = onCount > 0 && onCount < ids.length
  }, [onCount, ids.length])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={onCount === ids.length && ids.length > 0}
      onChange={() => onSet(ids, onCount < ids.length)}
      className="align-middle"
    />
  )
}

function ScopePanel({ options, off, setOff }: {
  options: OptionsResponse; off: Set<number>; setOff: (next: Set<number>) => void
}) {
  const [open, setOpen] = useState<Set<number>>(new Set())

  function set(ids: number[], on: boolean) {
    const next = new Set(off)
    ids.forEach(id => on ? next.delete(id) : next.add(id))
    setOff(next)
  }

  const toggleOpen = (id: number) => setOpen(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  if (options.staging.length === 0) {
    return <p className="text-[12px] text-muted">No doctrines with a staging location yet.</p>
  }

  return (
    <div className="space-y-3">
      {options.staging.map(loc => {
        const locIds = loc.doctrines.flatMap(d => d.fits.map(f => f.doctrine_fit_id))
        return (
          <div key={loc.location_id}>
            <label className="flex items-center gap-2 text-[12px] text-primary font-medium cursor-pointer">
              <TriBox ids={locIds} off={off} onSet={set} />
              {loc.location_name}
              {!loc.has_jita_route && <span className="text-[10px] text-eve-amber uppercase">no Jita freight route</span>}
            </label>
            <div className="ml-5 mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
              {loc.doctrines.map(d => {
                const ids = d.fits.map(f => f.doctrine_fit_id)
                const onCount = ids.filter(id => !off.has(id)).length
                const isOpen = open.has(d.doctrine_id)
                return (
                  <div key={d.doctrine_id} className={isOpen ? 'basis-full' : ''}>
                    <div className="flex items-center gap-1.5 text-[12px] text-secondary">
                      <TriBox ids={ids} off={off} onSet={set} />
                      <button onClick={() => toggleOpen(d.doctrine_id)} className="hover:text-accent transition-colors">
                        {d.doctrine_name}
                        <span className="text-faint ml-1">{onCount}/{ids.length} {isOpen ? '▲' : '▼'}</span>
                      </button>
                    </div>
                    {isOpen && (
                      <div className="ml-5 mt-1 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-4 gap-y-0.5">
                        {d.fits.map(f => (
                          <label key={f.doctrine_fit_id} className="flex items-center gap-1.5 text-[11px] text-muted cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!off.has(f.doctrine_fit_id)}
                              onChange={e => set([f.doctrine_fit_id], e.target.checked)}
                            />
                            <span className="truncate">{f.fit_name}</span>
                            <span className="text-faint">×{f.target_qty}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Group card ────────────────────────────────────────────────────────────────

function RowTable({ rows, onQty, onExclude, excludeLabel }: {
  rows: PricedRow[]
  onQty: (key: string, qty: number | null) => void
  onExclude: (typeId: number) => void
  excludeLabel: string
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const toggle = (tid: number) => setExpanded(prev => {
    const next = new Set(prev)
    next.has(tid) ? next.delete(tid) : next.add(tid)
    return next
  })

  return (
    <div className="rounded border border-wire overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead className="bg-surface-hi border-b border-wire">
          <tr>
            <th className={`${TH} text-left`}>Item</th>
            <th className={`${TH} text-right`} title="Pooled need across selected fits">Need</th>
            <th className={`${TH} text-right`} title="Units on the staging market">Local</th>
            <th className={`${TH} text-right`} title="Owned, unreserved, at this location">Owned</th>
            <th className={`${TH} text-right`}>To buy</th>
            <th className={`${TH} text-left`}>Source</th>
            <th className={`${TH} text-right`}>Landed/u</th>
            <th className={`${TH} text-right`}>Local sell</th>
            <th className={`${TH} text-right`}>Profit/u</th>
            <th className={`${TH} text-right`}>%</th>
            <th className={`${TH} text-right`}>Cost</th>
            <th className={`${TH} text-right`}>m³</th>
            <th className={`${TH} w-14`}></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-wire">
          {rows.map(p => {
            const r = p.row
            const pct = p.profitPerUnit != null && p.alloc.avg ? p.profitPerUnit / p.alloc.avg * 100 : null
            const isExpanded = expanded.has(r.type_id)
            return (
              <Fragment key={r.type_id}>
                <tr>
                  <td className={TD}>
                    <Link href={`/market/${r.type_id}`} className="text-primary hover:text-accent transition-colors">{r.name}</Link>
                    {r.reason && <span className="ml-1.5 text-[10px] text-faint uppercase">{REASON_LABEL[r.reason]}</span>}
                    {p.alloc.short > 0 && (
                      <span className="ml-1.5 text-[10px] text-eve-amber uppercase" title={`Only ${r.depth.toLocaleString()} available across sources`}>
                        short {p.alloc.short.toLocaleString()}
                      </span>
                    )}
                  </td>
                  <td className={`${TD} text-right font-mono text-muted`}>{r.qty_needed.toLocaleString()}</td>
                  <td className={`${TD} text-right font-mono text-muted`}>{r.qty_local.toLocaleString()}</td>
                  <td className={`${TD} text-right font-mono text-muted`}>{r.qty_owned ? r.qty_owned.toLocaleString() : '—'}</td>
                  <td className={`${TD} text-right`}>
                    <input
                      type="number"
                      min={0}
                      value={p.qty}
                      onChange={e => {
                        const v = Math.max(0, Math.floor(Number(e.target.value) || 0))
                        onQty(p.key, v === r.qty_to_buy ? null : v)
                      }}
                      className={`w-20 bg-canvas border rounded px-1.5 py-0.5 text-right font-mono text-[12px] focus:outline-none focus:border-accent ${
                        p.edited ? 'border-accent text-accent' : 'border-wire text-secondary'
                      }`}
                    />
                  </td>
                  <td className={`${TD} text-[11px] font-mono whitespace-nowrap`}>
                    {p.alloc.buyback > 0 && <span className="text-accent">BB {p.alloc.buyback.toLocaleString()}</span>}
                    {p.alloc.buyback > 0 && p.alloc.jita > 0 && <span className="text-faint"> · </span>}
                    {p.alloc.jita > 0 && <span className="text-muted">Jita {p.alloc.jita.toLocaleString()}</span>}
                    {p.alloc.buyback + p.alloc.jita === 0 && <span className="text-faint">—</span>}
                  </td>
                  <td className={`${TD} text-right font-mono text-muted`}>{iska(p.alloc.avg)}</td>
                  <td className={`${TD} text-right font-mono text-muted`}>{iska(r.staging_price)}</td>
                  <td className={`${TD} text-right font-mono ${profitCls(p.profitPerUnit)}`}>{iska(p.profitPerUnit)}</td>
                  <td className={`${TD} text-right font-mono ${profitCls(p.profitPerUnit)}`}>
                    {pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '—'}
                  </td>
                  <td className={`${TD} text-right font-mono text-secondary`}>{iska(p.alloc.cost)}</td>
                  <td className={`${TD} text-right font-mono text-muted`}>
                    {(r.unit_m3 * p.qty).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap text-right">
                    <button onClick={() => onExclude(r.type_id)} title={excludeLabel}
                            className="text-[11px] px-1 text-muted hover:text-eve-red transition-colors">✕</button>
                    <button onClick={() => toggle(r.type_id)} aria-label="Details"
                            className="text-[11px] px-1 text-muted hover:text-secondary transition-colors">
                      {isExpanded ? '▲' : '▼'}
                    </button>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="bg-canvas">
                    <td colSpan={13} className="px-4 py-2.5">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
                        <div className="space-y-0.5">
                          <div className="text-muted">
                            Need {r.qty_needed.toLocaleString()} − local {r.qty_local.toLocaleString()}
                            {r.qty_owned > 0 && <> − owned {r.qty_owned.toLocaleString()}</>}
                            {' '}= {r.qty_wanted.toLocaleString()} wanted
                            {r.velocity_daily != null && <> · sells {r.velocity_daily}/day</>}
                          </div>
                          {r.doctrines.map((d, i) => (
                            <div key={i} className="text-faint">{d.doctrine_name} / {d.fit_name}</div>
                          ))}
                        </div>
                        <div>
                          <div className="text-muted mb-0.5">Cheapest supply (landed incl. freight)</div>
                          {r.ladder.length === 0 && <div className="text-faint">No sell orders or buyback offers.</div>}
                          {r.ladder.slice(0, 8).map((l, i) => (
                            <div key={i} className="font-mono text-faint">
                              <span className={l.source === 'buyback' ? 'text-accent' : ''}>{l.source === 'buyback' ? 'BB  ' : 'Jita'}</span>
                              {' '}{l.qty.toLocaleString().padStart(7)} @ {iska(l.unit_price)} → {iska(l.landed)}
                            </div>
                          ))}
                        </div>
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
  )
}

function GroupCard({ group, overrides, excluded, onQty, onExclude, onRestore }: {
  group: PlanGroup
  overrides: Record<string, number>
  excluded: Set<number>
  onQty: (key: string, qty: number | null) => void
  onExclude: (typeId: number) => void
  onRestore: (typeIds: number[]) => void
}) {
  const [showSecondary, setShowSecondary] = useState(false)
  const [showExcluded, setShowExcluded] = useState(false)

  const all = useMemo(() => [...group.items, ...group.secondary], [group])
  const excludedRows = all.filter(r => excluded.has(r.type_id))
  const priced = group.items.filter(r => !excluded.has(r.type_id)).map(r => priceRow(r, group.location_id, overrides))
  const secondary = group.secondary.filter(r => !excluded.has(r.type_id)).map(r => priceRow(r, group.location_id, overrides))
  // Secondary rows only count toward totals/copy once the user gives them a quantity.
  const active = [...priced, ...secondary.filter(p => p.qty > 0)]

  const totalCost = active.reduce((s, p) => s + p.alloc.cost, 0)
  const totalProfit = active.reduce((s, p) => s + (p.profitTotal ?? 0), 0)
  const totalM3 = active.reduce((s, p) => s + p.row.unit_m3 * p.qty, 0)
  const jitaList = buildMultibuy(active.map(p => ({ name: p.row.name, qty: p.alloc.jita })))
  const bbList = buildMultibuy(active.map(p => ({ name: p.row.name, qty: p.alloc.buyback })))

  return (
    <div className="bg-surface border border-wire rounded p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-[13px] font-medium text-primary">{group.location_name}</div>
          <div className="text-[11px] text-muted mt-0.5 font-mono">
            {active.length} items · {iska(totalCost)} cost
            {' · '}<span className={profitCls(totalProfit)}>{iska(totalProfit)} vs local sell</span>
            {' · '}{totalM3.toLocaleString(undefined, { maximumFractionDigits: 0 })} m³
          </div>
        </div>
        <div className="flex gap-2">
          <CopyButton label="Copy Jita multibuy" text={jitaList} />
          {bbList && <CopyButton label="Copy buyback list" text={bbList} />}
        </div>
      </div>

      {group.freight_missing && (
        <div className="bg-eve-amber/10 border border-eve-amber/40 rounded px-3 py-2 text-[12px] text-eve-amber">
          No Jita → {group.location_name} freight route — Jita prices below exclude freight. Add one in Settings → Freight Routes.
        </div>
      )}
      {group.buyback_freight_missing && (
        <div className="bg-eve-amber/10 border border-eve-amber/40 rounded px-3 py-2 text-[12px] text-eve-amber">
          No freight route from the buyback location to {group.location_name} — buyback prices exclude freight.
        </div>
      )}

      {priced.length > 0 ? (
        <RowTable rows={priced} onQty={onQty} onExclude={onExclude} excludeLabel="Exclude item" />
      ) : (
        <p className="text-[12px] text-muted">Nothing recommended here.</p>
      )}

      {secondary.length > 0 && (
        <div>
          <button onClick={() => setShowSecondary(v => !v)} className="text-[11px] text-muted hover:text-accent transition-colors">
            {showSecondary ? '▲' : '▼'} {secondary.length} not recommended (no supply, unprofitable, or no sales) — set a qty to include
          </button>
          {showSecondary && (
            <div className="mt-2">
              <RowTable rows={secondary} onQty={onQty} onExclude={onExclude} excludeLabel="Exclude item" />
            </div>
          )}
        </div>
      )}

      {excludedRows.length > 0 && (
        <div>
          <button onClick={() => setShowExcluded(v => !v)} className="text-[11px] text-muted hover:text-accent transition-colors">
            {showExcluded ? '▲' : '▼'} {excludedRows.length} excluded
          </button>
          {showExcluded && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {excludedRows.map(r => (
                <button key={r.type_id} onClick={() => onRestore([r.type_id])} className={chip(false)} title="Restore">
                  {r.name} ↺
                </button>
              ))}
              <button onClick={() => onRestore(excludedRows.map(r => r.type_id))} className="text-[11px] text-muted hover:text-accent px-2">
                Restore all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const DEFAULT_PREFS: Prefs = { mode: 'fill', fillPct: 100, netInventory: true, windowDays: 14 }

export function ShoppingClient() {
  const [options, setOptions] = useState<OptionsResponse | null>(null)
  // Saved state is restored after mount (not in useState initializers) so the
  // server-rendered markup matches the first client render.
  const [hydrated, setHydrated] = useState(false)
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS)
  // Deselected fits are stored (not selected ones) so newly added fits are included by default.
  const [scopeOff, setScopeOffState] = useState<Set<number>>(new Set())
  const [excluded, setExcludedState] = useState<Set<number>>(new Set())
  const [overrides, setOverridesState] = useState<Record<string, number>>({})
  const [scopeOpen, setScopeOpen] = useState(false)
  const [buybackOpen, setBuybackOpen] = useState(false)
  const [bbText, setBbText] = useState('')
  const [bbPriceType, setBbPriceType] = useState<PriceType>('buy')
  const [bbLocationId, setBbLocationId] = useState<number | ''>('')
  const [appliedBuyback, setAppliedBuyback] = useState({ text: '', priceType: 'buy' as PriceType, locationId: '' as number | '' })
  const [data, setData] = useState<PlanResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const setPrefs = (patch: Partial<Prefs>) => setPrefsState(prev => {
    const next = { ...prev, ...patch }
    saveJson('shop_prefs', next)
    return next
  })
  const setScopeOff = (next: Set<number>) => { setScopeOffState(next); saveJson('shop_scope_off', [...next]) }
  const setExcluded = (next: Set<number>) => { setExcludedState(next); saveJson('shop_excluded', [...next]) }
  const setOverrides = (next: Record<string, number>) => { setOverridesState(next); saveJson('shop_qty_overrides', next) }

  useEffect(() => {
    setPrefsState({ ...DEFAULT_PREFS, ...loadJson<Partial<Prefs>>('shop_prefs', {}) })
    setScopeOffState(new Set(loadJson<number[]>('shop_scope_off', [])))
    setExcludedState(new Set(loadJson<number[]>('shop_excluded', [])))
    setOverridesState(loadJson('shop_qty_overrides', {}))
    setHydrated(true)
  }, [])

  // ?fits=1,2,3 (from "Buy what's missing" on the Doctrines page) replaces the saved
  // scope with exactly those doctrine-fits, then the parameter is dropped from the URL.
  const searchParams = useSearchParams()
  const router = useRouter()
  const urlFits = searchParams.get('fits')

  useEffect(() => {
    if (!options || !hydrated || urlFits == null) return
    const wanted = new Set(urlFits.split(',').map(Number).filter(Number.isFinite))
    const all = options.staging.flatMap(l => l.doctrines.flatMap(d => d.fits.map(f => f.doctrine_fit_id)))
    setScopeOff(new Set(all.filter(id => !wanted.has(id))))
    setScopeOpen(true)
    router.replace('/shopping', { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, hydrated, urlFits])

  useEffect(() => {
    fetch('/api/shopping/options')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(setOptions)
      .catch(() => setError('Failed to load doctrines.'))
  }, [])

  const selectedFitIds = useMemo(() => {
    if (!options) return null
    return options.staging.flatMap(l => l.doctrines.flatMap(d => d.fits.map(f => f.doctrine_fit_id)))
      .filter(id => !scopeOff.has(id))
  }, [options, scopeOff])

  const scopeKey = selectedFitIds?.join(',')

  const load = useCallback(() => {
    if (!selectedFitIds || !hydrated || urlFits != null) return
    setLoading(true)
    setError(null)
    fetch('/api/shopping/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: prefs.mode,
        doctrine_fit_ids: selectedFitIds,
        fill_pct: prefs.fillPct / 100,
        net_inventory: prefs.netInventory,
        window_days: prefs.windowDays,
        buyback_text: appliedBuyback.text,
        buyback_price_type: appliedBuyback.priceType,
        buyback_location_id: appliedBuyback.locationId || null,
      }),
    })
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(setData)
      .catch(() => setError('Failed to build shopping plan.'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, urlFits, scopeKey, prefs.mode, prefs.fillPct, prefs.netInventory, prefs.windowDays, appliedBuyback])

  useEffect(() => {
    const t = setTimeout(load, 300)
    return () => clearTimeout(t)
  }, [load])

  function onQty(key: string, qty: number | null) {
    const next = { ...overrides }
    if (qty == null) delete next[key]; else next[key] = qty
    setOverrides(next)
  }
  function onExclude(typeId: number) { setExcluded(new Set(excluded).add(typeId)) }
  function onRestore(typeIds: number[]) {
    const next = new Set(excluded)
    typeIds.forEach(t => next.delete(t))
    setExcluded(next)
  }

  const allJita = useMemo(() => {
    if (!data) return ''
    const totals = new Map<string, number>()
    for (const g of data.groups) {
      for (const r of [...g.items, ...g.secondary]) {
        if (excluded.has(r.type_id)) continue
        const p = priceRow(r, g.location_id, overrides)
        if (p.alloc.jita > 0) totals.set(r.name, (totals.get(r.name) ?? 0) + p.alloc.jita)
      }
    }
    return buildMultibuy([...totals].map(([name, qty]) => ({ name, qty })))
  }, [data, excluded, overrides])

  const totalFits = options?.staging.reduce((s, l) => s + l.doctrines.reduce((t, d) => t + d.fits.length, 0), 0) ?? 0
  const editCount = Object.keys(overrides).length
  const buybackDirty = bbText !== appliedBuyback.text || bbPriceType !== appliedBuyback.priceType || bbLocationId !== appliedBuyback.locationId

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-x-5 gap-y-2 flex-wrap">
        <div className="flex gap-1.5">
          <button onClick={() => setPrefs({ mode: 'fill' })} className={chip(prefs.mode === 'fill')}
                  title="Buy everything missing to reach doctrine targets">Fill doctrines</button>
          <button onClick={() => setPrefs({ mode: 'profit' })} className={chip(prefs.mode === 'profit')}
                  title="Only what sells locally above landed cost, capped by sales speed">Seed for profit</button>
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-faint">
          Fill to
          <input
            type="number" min={0} max={500} step={10} value={prefs.fillPct}
            onChange={e => setPrefs({ fillPct: Math.max(0, Math.min(500, Number(e.target.value) || 0)) })}
            className="w-16 bg-canvas border border-wire rounded px-1.5 py-0.5 text-right font-mono text-[12px] text-secondary focus:outline-none focus:border-accent"
          />
          % of target
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-secondary cursor-pointer">
          <input type="checkbox" checked={prefs.netInventory} onChange={e => setPrefs({ netInventory: e.target.checked })} />
          Subtract owned inventory
        </label>
        {prefs.mode === 'profit' && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-faint">Sell-through window</span>
            {WINDOWS.map(d => (
              <button key={d} onClick={() => setPrefs({ windowDays: d })} className={chip(prefs.windowDays === d)}>{d}d</button>
            ))}
          </div>
        )}
        {data?.generated_at && <span className="text-[11px] text-faint ml-auto">Priced as of {fmtSynced(data.generated_at)}</span>}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => setScopeOpen(v => !v)} className={chip(scopeOpen)}>
          Scope: {selectedFitIds?.length ?? 0}/{totalFits} fits {scopeOpen ? '▲' : '▼'}
        </button>
        <button onClick={() => setBuybackOpen(v => !v)} className={chip(buybackOpen)}>
          Buyback paste{data?.buyback_count ? ` (${data.buyback_count} items)` : ''} {buybackOpen ? '▲' : '▼'}
        </button>
        <div className="ml-auto flex gap-2">
          {editCount > 0 && <button onClick={() => setOverrides({})} className={BTN}>Reset {editCount} qty edit{editCount > 1 ? 's' : ''}</button>}
          {excluded.size > 0 && <button onClick={() => setExcluded(new Set())} className={BTN}>Restore {excluded.size} excluded</button>}
          <CopyButton label="Copy all Jita multibuy" text={allJita} />
        </div>
      </div>

      {scopeOpen && options && (
        <div className="bg-surface border border-wire rounded p-4">
          <div className="flex gap-3 mb-3 text-[11px]">
            <button onClick={() => setScopeOff(new Set())} className="text-muted hover:text-accent">Select all</button>
            <button
              onClick={() => setScopeOff(new Set(options.staging.flatMap(l => l.doctrines.flatMap(d => d.fits.map(f => f.doctrine_fit_id)))))}
              className="text-muted hover:text-accent"
            >Select none</button>
          </div>
          <ScopePanel options={options} off={scopeOff} setOff={setScopeOff} />
        </div>
      )}

      {buybackOpen && (
        <div className="bg-surface border border-wire rounded p-4 space-y-3">
          <p className="text-[12px] text-muted">
            In Janice, select all rows and copy. Offered items are used wherever they land cheaper than Jita (up to the offered qty).
            Expected columns: <span className="text-faint font-mono">Name · Qty · Volume · Buy price · Sell price</span>
          </p>
          <textarea
            value={bbText}
            onChange={e => setBbText(e.target.value)}
            rows={8}
            placeholder={"Damage Control II\t10\t50.00\t350000.00\t370000.00"}
            className="w-full bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary placeholder:text-faint focus:outline-none focus:border-accent resize-none"
          />
          <div className="flex gap-3 items-end flex-wrap">
            <div>
              <label className="block text-[11px] text-muted mb-1.5">Delivered at</label>
              <select
                value={bbLocationId}
                onChange={e => setBbLocationId(e.target.value ? Number(e.target.value) : '')}
                className="bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
              >
                <option value="">Staging location (no freight)</option>
                {options?.locations.map(l => <option key={l.location_id} value={l.location_id}>{l.location_name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-muted mb-1.5">Price you pay</label>
              <div className="flex gap-1.5">
                {PRICE_TYPES.map(pt => (
                  <button key={pt.value} onClick={() => setBbPriceType(pt.value)} className={chip(bbPriceType === pt.value)}>{pt.label}</button>
                ))}
              </div>
            </div>
            <div className="ml-auto flex gap-2">
              {appliedBuyback.text && (
                <button onClick={() => { setBbText(''); setAppliedBuyback({ text: '', priceType: bbPriceType, locationId: bbLocationId }) }} className={BTN}>
                  Clear
                </button>
              )}
              <button
                onClick={() => setAppliedBuyback({ text: bbText, priceType: bbPriceType, locationId: bbLocationId })}
                disabled={!buybackDirty}
                className="px-3 py-1 text-[12px] border border-accent text-accent hover:bg-accent hover:text-canvas rounded transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                Apply
              </button>
            </div>
          </div>
          {data && (data.buyback_parse_errors.length > 0 || data.buyback_unknown.length > 0 || data.buyback_unused.length > 0) && (
            <div className="space-y-1 text-[11px]">
              {data.buyback_parse_errors.map((e, i) => <div key={i} className="text-eve-red">{e}</div>)}
              {data.buyback_unknown.length > 0 && (
                <div className="text-eve-amber">Unknown items: {data.buyback_unknown.map(u => u.item_name).join(', ')}</div>
              )}
              {data.buyback_unused.length > 0 && (
                <div className="text-faint">Not needed by selected doctrines: {data.buyback_unused.join(', ')}</div>
              )}
            </div>
          )}
        </div>
      )}

      {error ? (
        <div className="bg-surface border border-wire rounded p-8 text-center text-muted text-[13px]">{error}</div>
      ) : loading && !data ? (
        <div className="h-40 bg-surface border border-wire rounded animate-pulse" />
      ) : !data ? null : data.groups.length === 0 ? (
        <div className="bg-surface border border-wire rounded p-8 text-center text-muted text-[13px]">
          Nothing to buy — every selected fit is fully stocked on the local market{prefs.netInventory ? ' or by owned inventory' : ''}.
        </div>
      ) : (
        <div className={`space-y-4 ${loading ? 'opacity-60' : ''}`}>
          {data.groups.map(g => (
            <GroupCard
              key={g.location_id}
              group={g}
              overrides={overrides}
              excluded={excluded}
              onQty={onQty}
              onExclude={onExclude}
              onRestore={onRestore}
            />
          ))}
        </div>
      )}
    </div>
  )
}
