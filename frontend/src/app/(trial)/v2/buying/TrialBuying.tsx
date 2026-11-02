'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { MarketFreshness, Selection, TriCheckbox, isk } from '../_shared/doctrines'
import { Switch } from '../_shared/ui'
import { Th, sortRows, useSort } from '../_shared/sort'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FitOption { doctrine_fit_id: number; fit_name: string; ship_name: string; target_qty: number }
interface DoctrineOption { doctrine_id: number; doctrine_name: string; fits: FitOption[] }
interface StagingOption { location_id: number; location_name: string; has_jita_route: boolean; doctrines: DoctrineOption[] }
interface Options {
  staging: StagingOption[]
  locations: { location_id: number; location_name: string }[]
  jita_location_id: number | null
  projects: { id: number; name: string; status: string; location_id: number }[]
  ore_efficiency_pct: number
  gas_efficiency_pct: number
}

type Channel = 'jita' | 'buyback' | 'local'

interface Purchase {
  type_id: number
  name: string
  channel: Channel
  qty: number
  cost: number
  raw_cost: number
  unit_cost: number | null
  m3: number
  is_ore: boolean
  contributes_to: string[]
  for: { doctrine: boolean; project: boolean; want: boolean }
  doctrines: string[]
  projects: string[]
  local_sell: number | null
  profit_per_unit: number | null
  unit_price: number | null
  freight_per_unit: number | null
  sold_30d: number | null
}

interface Need {
  type_id: number
  name: string
  qty: number
  qty_natural: number
  edited: boolean
  covered: number
  unmet: number
  unmet_reason: 'unprofitable' | 'no_supply' | null
  for: { doctrine: number; project: number; want: number }
  doctrines: { doctrine_name: string; fit_name: string }[]
  projects: string[]
  velocity_daily: number | null
}

interface LocationPlan {
  location_id: number
  location_name: string
  jita_freight_missing: boolean
  buyback_freight_missing: boolean
  needs: Need[]
  purchases: Purchase[]
  total_cost: number
  total_m3: number
}

interface FlipEntry {
  type_id: number
  name: string
  qty: number
  unit_price: number
  sell_price?: number
  profit_per_unit?: number
  profit_pct?: number | null
  total_profit?: number
  velocity_daily?: number
  days_to_sell?: number | null
}

interface Plan {
  generated_at: string | null
  locations: LocationPlan[]
  hidden: { location_id: number; type_id: number; name: string; qty_natural: number; excluded: boolean }[]
  no_sales: { location_id: number; type_id: number; name: string }[]
  flip: { location_id: number; location_name: string; recommended: FlipEntry[]; unprofitable: FlipEntry[]; unpriced: FlipEntry[] } | null
  total_cost: number
  buyback: { count: number; unknown: { item_name: string; qty: number }[]; parse_errors: string[]; repriced_ore: string[] }
  want_unknown: string[]
}

interface Prefs {
  includeDoctrines: boolean
  mode: 'fill' | 'profit'
  fillPct: number
  windowDays: number
  includeProjects: boolean
  projectIds: number[]          // empty = every active project
  netInventory: boolean
  useLocal: boolean
  useOre: boolean
  wantLocationId: number | ''
  checkFlips: boolean
  flipLocationId: number | ''
}

const DEFAULT_PREFS: Prefs = {
  includeDoctrines: true, mode: 'fill', fillPct: 100, windowDays: 14,
  includeProjects: true, projectIds: [], netInventory: true, useLocal: true, useOre: true, wantLocationId: '',
  checkFlips: false, flipLocationId: '',
}

const CHANNEL_LABEL: Record<Channel, string> = { jita: 'Jita', buyback: 'Buyback offer', local: 'Local market' }
const CHANNEL_ORDER: Channel[] = ['buyback', 'local', 'jita']

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJson<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key)
    return s ? (JSON.parse(s) as T) : fallback
  } catch { return fallback }
}

function saveJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value))
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

function multibuy(items: { name: string; qty: number }[]): string {
  return items.filter(i => i.qty > 0).map(i => `${i.name} x${i.qty}`).join('\n')
}

function CopyButton({ text, label, primary }: { text: string; label: string; primary?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={primary ? 'v2-btn primary' : 'v2-btn'}
      disabled={!text}
      onClick={async () => { await copyText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}
    >
      {done ? 'Copied' : label}
    </button>
  )
}


// ── Doctrine scope picker ─────────────────────────────────────────────────────

function ScopePicker({ options, selection }: { options: Options; selection: Selection }) {
  const [open, setOpen] = useState<Set<number>>(new Set())
  return (
    <div className="v2-scope">
      {options.staging.map(loc => {
        const locIds = loc.doctrines.flatMap(d => d.fits.map(f => f.doctrine_fit_id))
        return (
          <div key={loc.location_id} className="v2-scope-loc">
            <label className="v2-scope-row strong">
              <TriCheckbox ids={locIds} selection={selection} label={`Select every fit at ${loc.location_name}`} />
              {loc.location_name}
            </label>
            {loc.doctrines.map(d => {
              const ids = d.fits.map(f => f.doctrine_fit_id)
              const on = ids.filter(id => selection.selected.has(id)).length
              const isOpen = open.has(d.doctrine_id)
              return (
                <div key={d.doctrine_id} className="v2-scope-doc">
                  <div className="v2-scope-row">
                    <TriCheckbox ids={ids} selection={selection} label={`Select every fit in ${d.doctrine_name}`} />
                    <button
                      className="v2-scope-toggle"
                      aria-expanded={isOpen}
                      onClick={() => setOpen(prev => {
                        const next = new Set(prev)
                        next.has(d.doctrine_id) ? next.delete(d.doctrine_id) : next.add(d.doctrine_id)
                        return next
                      })}
                    >
                      {d.doctrine_name} <span className="muted">{on} of {ids.length}</span>
                    </button>
                  </div>
                  {isOpen && (
                    <div className="v2-scope-fits">
                      {d.fits.map(f => (
                        <label key={f.doctrine_fit_id} className="v2-scope-row">
                          <TriCheckbox ids={[f.doctrine_fit_id]} selection={selection} label={`Select ${f.fit_name}`} />
                          <span className="fit">{f.fit_name}</span>
                          <span className="muted">target {f.target_qty}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ── Per-location result ──────────────────────────────────────────────────────

function NeedTags({ n }: { n: Need }) {
  const doctrines = [...new Set(n.doctrines.map(d => d.doctrine_name))]
  const parts = [
    n.for.doctrine > 0 && (doctrines.length === 1 ? doctrines[0] : `${doctrines.length} doctrines`),
    n.for.project > 0 && (n.projects.length === 1 ? n.projects[0] : `${n.projects.length} projects`),
    n.for.want > 0 && 'Want list',
  ].filter(Boolean)
  const detail = [
    ...n.doctrines.map(d => `${d.doctrine_name}: ${d.fit_name}`),
    ...n.projects.map(p => `Project: ${p}`),
  ].join('\n')
  return <span className="v2-need-for" title={detail || undefined}>{parts.join(', ')}</span>
}

function purposeOf(p: Purchase): string {
  const parts = [
    p.for.doctrine && (p.doctrines.length === 1 ? p.doctrines[0] : `${p.doctrines.length} doctrines`),
    p.for.project && (p.projects.length === 1 ? p.projects[0] : `${p.projects.length} projects`),
    p.for.want && 'Want list',
  ].filter(Boolean)
  return parts.join(', ')
}

/** Quantity editor that re-plans on change. It shows `value` (what this row buys) and
 *  sets the need to the typed number plus `others`: what other sources already cover. */
function QtyInput({ need, locationId, onQty, value = need.qty, others = 0 }: {
  need: Need; locationId: number; onQty: (key: string, qty: number | null) => void
  value?: number; others?: number
}) {
  return (
    <input
      type="number" min={0} value={value}
      className={`v2-qty${need.edited ? ' edited' : ''}`}
      aria-label={`Quantity of ${need.name} to buy`}
      title={need.edited ? `Changed from ${need.qty_natural.toLocaleString('en-US')}` : 'Change to re-plan'}
      onChange={e => {
        const v = Math.max(0, Math.floor(Number(e.target.value) || 0)) + others
        onQty(`${locationId}:${need.type_id}`, v === need.qty_natural ? null : v)
      }}
    />
  )
}

type ShopSortKey = 'item' | 'for' | 'qty' | 'price' | 'freight' | 'staging' | 'sold' | 'cost' | 'profit'

function ShoppingList({ ch, items, locationId, deselected, onToggle, needByType, onQty, onExclude }: {
  ch: Channel
  items: Purchase[]
  locationId: number
  deselected: Set<string>
  onToggle: (keys: string[], on: boolean) => void
  needByType: Map<number, Need>
  onQty: (key: string, qty: number | null) => void
  onExclude: (typeId: number) => void
}) {
  const keyOf = (p: Purchase) => `${locationId}:${p.channel}:${p.type_id}`
  const profitOf = (p: Purchase) => (p.for.doctrine && p.profit_per_unit != null ? p.profit_per_unit * p.qty : null)
  const sort = useSort<ShopSortKey>(null)
  const rows = useMemo(() => sortRows(items, sort, (p, k) => {
    switch (k) {
      case 'item': return p.name
      case 'for': return purposeOf(p)
      case 'qty': return p.qty
      case 'price': return p.unit_price
      case 'freight': return p.freight_per_unit
      case 'staging': return p.local_sell
      case 'sold': return p.sold_30d
      case 'cost': return p.cost
      case 'profit': return profitOf(p)
    }
  }), [items, sort.key, sort.dir]) // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = items.filter(p => !deselected.has(keyOf(p)))
  const total = chosen.reduce((s, p) => s + p.cost, 0)
  const profit = chosen.reduce((s, p) => s + (profitOf(p) ?? 0), 0)
  const anyProfit = items.some(p => profitOf(p) != null)
  const anyFreight = items.some(p => (p.freight_per_unit ?? 0) > 0)
  const keys = items.map(keyOf)
  const allOn = chosen.length === items.length
  const someOn = chosen.length > 0

  return (
    <div className={`v2-list ch-${ch}`}>
      <div className="v2-list-head">
        <h4>{CHANNEL_LABEL[ch]}</h4>
        <span className="muted">
          {chosen.length === items.length ? `${items.length} items` : `${chosen.length} of ${items.length} items`}, {isk(total)}
          {anyProfit && <>, <span className={profit >= 0 ? 'up' : 'down'}>{profit >= 0 ? '+' : ''}{isk(profit)} if resold</span></>}
        </span>
        <CopyButton
          text={multibuy(chosen)}
          label={ch === 'jita' ? 'Copy multibuy' : 'Copy list'}
          primary={ch === 'jita'}
        />
      </div>
      <div className="v2-list-scroll">
        <table className="v2-table compact flush">
          <thead>
            <tr>
              <th className="sel">
                <input
                  type="checkbox" className="v2-check" checked={allOn}
                  ref={el => { if (el) el.indeterminate = someOn && !allOn }}
                  onChange={() => onToggle(keys, !allOn)}
                  aria-label={`Select every ${CHANNEL_LABEL[ch]} item`}
                />
              </th>
              <Th label="Item" k="item" sort={sort} defaultDir="asc" />
              <Th label="For" k="for" sort={sort} defaultDir="asc" />
              <Th label="Qty" k="qty" sort={sort} align="right" title="What you buy here. Change it to re-plan." />
              <Th label={ch === 'jita' ? 'Jita/unit' : 'Price/unit'} k="price" sort={sort} align="right" title="Average price paid per unit, before freight" />
              {anyFreight && <Th label="Freight/unit" k="freight" sort={sort} align="right" title="m³ × ISK/m³ plus collateral, from Settings → Locations" />}
              <Th label="Staging price" k="staging" sort={sort} align="right" title="Lowest sell order at this location" />
              <Th label="Sold 30d" k="sold" sort={sort} align="right" title="Units traded in the last 30 days. ESI history is per region, so for a structure this is the whole region." />
              <Th label="Cost" k="cost" sort={sort} align="right" title="Total, freight included" />
              <Th label="Profit" k="profit" sort={sort} align="right" title="Staging price after broker fee, sales tax and SCC, minus what you pay per unit including freight, × qty. Only for doctrine items you'd list here." />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(p => {
              const k = keyOf(p)
              const on = !deselected.has(k)
              const prof = profitOf(p)
              const pct = prof != null && p.unit_cost ? (p.profit_per_unit! / p.unit_cost) * 100 : null
              const need = p.is_ore ? undefined : needByType.get(p.type_id)
              return (
                <tr key={k} className={on ? undefined : 'off'}>
                  <td className="sel">
                    <input
                      type="checkbox" className="v2-check" checked={on}
                      onChange={() => onToggle([k], !on)} aria-label={`Buy ${p.name}`}
                    />
                  </td>
                  <td>
                    <Link href={`/v2/items/${p.type_id}`} className="name">{p.name}</Link>
                    {p.is_ore && (
                      <span className="ore" title={`Reprocess into ${p.contributes_to.join(', ')}`}>
                        {' '}reprocess into {p.contributes_to.length > 2 ? `${p.contributes_to.length} materials` : p.contributes_to.join(', ')}
                      </span>
                    )}
                  </td>
                  <td className="muted for" title={[...p.doctrines, ...p.projects.map(x => `Project: ${x}`)].join('\n') || undefined}>
                    {purposeOf(p)}
                  </td>
                  <td className="num">
                    {need
                      ? <QtyInput need={need} locationId={locationId} onQty={onQty}
                          value={p.qty} others={Math.max(0, need.covered - p.qty)} />
                      : p.qty.toLocaleString('en-US')}
                  </td>
                  <td className="num">{isk(p.unit_price)}</td>
                  {anyFreight && <td className="num muted">{p.freight_per_unit ? isk(p.freight_per_unit) : '–'}</td>}
                  <td className="num muted">{p.local_sell != null ? isk(p.local_sell) : '–'}</td>
                  <td className="num muted">{p.sold_30d != null ? p.sold_30d.toLocaleString('en-US') : '–'}</td>
                  <td className="num">{isk(p.cost)}</td>
                  <td className="num">
                    {prof != null
                      ? <span className={prof >= 0 ? 'up' : 'down'} title={`${isk(p.profit_per_unit)} per unit`}>
                          {isk(prof)}{pct != null && <span className="muted"> ({pct >= 0 ? '+' : ''}{pct.toFixed(0)}%)</span>}
                        </span>
                      : <span className="muted">–</span>}
                  </td>
                  <td className="num">
                    {!p.is_ore && (
                      <button className="v2-x" onClick={() => onExclude(p.type_id)} aria-label={`Don't buy ${p.name}`} title="Don't buy this">✕</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function LocationResult({ plan, onQty, onExclude, deselected, onToggle }: {
  plan: LocationPlan
  onQty: (key: string, qty: number | null) => void
  onExclude: (typeId: number) => void
  deselected: Set<string>
  onToggle: (keys: string[], on: boolean) => void
}) {
  const byChannel = CHANNEL_ORDER
    .map(ch => ({ ch, items: plan.purchases.filter(p => p.channel === ch) }))
    .filter(g => g.items.length > 0)
  const needByType = useMemo(() => new Map(plan.needs.map(n => [n.type_id, n])), [plan.needs])
  const unmet = plan.needs.filter(n => n.unmet > 0)

  return (
    <section className="v2-buy-loc" aria-label={plan.location_name}>
      <div className="v2-buy-loc-head">
        <h3>{plan.location_name}</h3>
        <p>
          {isk(plan.total_cost)} ISK for {plan.needs.length} item{plan.needs.length === 1 ? '' : 's'},{' '}
          {plan.total_m3.toLocaleString('en-US', { maximumFractionDigits: 0 })} m³ to move
        </p>
      </div>
      {plan.jita_freight_missing && (
        <p className="v2-warn">No freight route from Jita to {plan.location_name}, so Jita prices here leave out freight. Add one in Settings.</p>
      )}
      {plan.buyback_freight_missing && (
        <p className="v2-warn">No freight route from the buyback location to {plan.location_name}, so buyback prices here leave out freight.</p>
      )}

      {unmet.length > 0 && (
        <p className="v2-buy-short">
          <span className="label">Couldn&apos;t fully cover</span>
          {unmet.map(n => (
            <span
              key={n.type_id} className={`v2-short-chip ${n.covered > 0 ? 'is-partial' : 'is-short'}`}
              title={`${n.unmet_reason === 'unprofitable' ? 'No profitable supply' : 'Not enough supply'}. For: ${[...new Set(n.doctrines.map(d => d.doctrine_name)), ...n.projects].join(', ') || 'want list'}`}
            >
              <Link href={`/v2/items/${n.type_id}`} className="name">{n.name}</Link>
              <span className="muted">{n.covered.toLocaleString('en-US')} of {n.qty.toLocaleString('en-US')}</span>
              <button className="v2-x" onClick={() => onExclude(n.type_id)} aria-label={`Don't buy ${n.name}`} title="Don't buy this">✕</button>
            </span>
          ))}
        </p>
      )}

      <div className="v2-buy-lists">
        <div className="v2-col-head">
          <h4>Shopping lists</h4>
          <p>What to buy, by where to buy it. Untick anything you&apos;ll skip; copy buttons only include ticked items. Change a quantity or press ✕ to re-plan.</p>
        </div>
        {byChannel.length === 0 && <p className="v2-empty">Nothing to buy here.</p>}
        {byChannel.map(({ ch, items }) => (
          <ShoppingList
            key={ch} ch={ch} items={items} locationId={plan.location_id}
            deselected={deselected} onToggle={onToggle}
            needByType={needByType} onQty={onQty} onExclude={onExclude}
          />
        ))}
      </div>
    </section>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function TrialBuying() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const urlFits = searchParams.get('fits')
  const urlProjects = searchParams.get('projects')
  const flipSort = useSort<'item' | 'qty' | 'offer' | 'sells' | 'profit' | 'velocity'>(null)

  const [options, setOptions] = useState<Options | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS)
  const [scopeOff, setScopeOffState] = useState<Set<number>>(new Set())
  const [excluded, setExcludedState] = useState<Set<number>>(new Set())
  const [overrides, setOverridesState] = useState<Record<string, number>>({})
  // Purchase lines the user unticked ("loc:channel:type"); everything is ticked by default.
  const [deselected, setDeselectedState] = useState<Set<string>>(new Set())
  const [scopeOpen, setScopeOpen] = useState(false)

  const [wantText, setWantText] = useState('')
  const [bbText, setBbText] = useState('')
  const [bbPriceType, setBbPriceType] = useState<'buy' | 'sell' | 'split'>('buy')
  const [bbLocationId, setBbLocationId] = useState<number | ''>('')
  const [applied, setApplied] = useState({ want: '', bb: '', bbPriceType: 'buy' as 'buy' | 'sell' | 'split', bbLocationId: '' as number | '' })

  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setPrefs = (patch: Partial<Prefs>) => setPrefsState(prev => {
    const next = { ...prev, ...patch }
    saveJson('buy_prefs', next)
    return next
  })
  const setScopeOff = (next: Set<number>) => { setScopeOffState(next); saveJson('buy_scope_off', [...next]) }
  const setExcluded = (next: Set<number>) => { setExcludedState(next); saveJson('buy_excluded', [...next]) }
  const setOverrides = (next: Record<string, number>) => { setOverridesState(next); saveJson('buy_qty_overrides', next) }
  const setDeselected = (next: Set<string>) => { setDeselectedState(next); saveJson('buy_deselected', [...next]) }
  function togglePurchases(keys: string[], on: boolean) {
    const next = new Set(deselected)
    keys.forEach(k => (on ? next.delete(k) : next.add(k)))
    setDeselected(next)
  }

  useEffect(() => {
    setPrefsState({ ...DEFAULT_PREFS, ...loadJson<Partial<Prefs>>('buy_prefs', {}) })
    setScopeOffState(new Set(loadJson<number[]>('buy_scope_off', [])))
    setExcludedState(new Set(loadJson<number[]>('buy_excluded', [])))
    setOverridesState(loadJson('buy_qty_overrides', {}))
    setDeselectedState(new Set(loadJson<string[]>('buy_deselected', [])))
    setHydrated(true)
    fetch('/api/buying/options')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(setOptions)
      .catch(() => setError('The buying options couldn’t be loaded. Check that the backend is running, then reload.'))
  }, [])

  const allFitIds = useMemo(
    () => options?.staging.flatMap(l => l.doctrines.flatMap(d => d.fits.map(f => f.doctrine_fit_id))) ?? [],
    [options],
  )

  // ?fits=… (Doctrines page) or ?projects=… (a project) narrows the plan to just that,
  // then the parameters are dropped so a reload keeps the user's own choices.
  useEffect(() => {
    if (!options || !hydrated || (urlFits == null && urlProjects == null)) return
    const patch: Partial<Prefs> = {}
    if (urlFits != null) {
      const wanted = new Set(urlFits.split(',').map(Number))
      setScopeOff(new Set(allFitIds.filter(id => !wanted.has(id))))
      setScopeOpen(true)
      patch.includeDoctrines = true
      patch.includeProjects = urlProjects != null
    }
    if (urlProjects != null) {
      patch.includeProjects = true
      patch.projectIds = urlProjects.split(',').map(Number).filter(Number.isFinite)
      if (urlFits == null) patch.includeDoctrines = false
    }
    setPrefs(patch)
    router.replace('/v2/buying', { scroll: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, hydrated, urlFits, urlProjects])

  const selection: Selection = useMemo(() => ({
    selected: new Set(allFitIds.filter(id => !scopeOff.has(id))),
    set: (ids, on) => {
      const next = new Set(scopeOff)
      ids.forEach(id => (on ? next.delete(id) : next.add(id)))
      setScopeOff(next)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [allFitIds, scopeOff])

  const selectedFitIds = useMemo(() => allFitIds.filter(id => !scopeOff.has(id)), [allFitIds, scopeOff])

  const load = useCallback(() => {
    if (!options || !hydrated || urlFits != null || urlProjects != null) return
    setLoading(true)
    setError(null)
    fetch('/api/buying/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        include_doctrines: prefs.includeDoctrines,
        doctrine_fit_ids: selectedFitIds,
        fill_pct: prefs.fillPct / 100,
        doctrine_mode: prefs.mode,
        window_days: prefs.windowDays,
        include_projects: prefs.includeProjects,
        project_ids: prefs.projectIds.length ? prefs.projectIds : null,
        want_text: applied.want,
        want_location_id: prefs.wantLocationId || null,
        net_inventory: prefs.netInventory,
        use_local: prefs.useLocal,
        use_ore: prefs.useOre,
        buyback_text: applied.bb,
        buyback_price_type: applied.bbPriceType,
        buyback_location_id: applied.bbLocationId || null,
        flip_location_id: prefs.checkFlips && applied.bb.trim() ? (prefs.flipLocationId || applied.bbLocationId || null) : null,
        exclude_type_ids: [...excluded],
        qty_overrides: overrides,
      }),
    })
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(setPlan)
      .catch(() => setError('The plan couldn’t be built. Check that the backend is running, then try again.'))
      .finally(() => setLoading(false))
  }, [options, hydrated, urlFits, urlProjects, prefs, selectedFitIds, applied, excluded, overrides])

  useEffect(() => {
    const t = setTimeout(load, 350)
    return () => clearTimeout(t)
  }, [load])

  function onQty(key: string, qty: number | null) {
    const next = { ...overrides }
    if (qty == null) delete next[key]; else next[key] = qty
    setOverrides(next)
  }

  const textDirty = wantText !== applied.want || bbText !== applied.bb || bbPriceType !== applied.bbPriceType
    || bbLocationId !== applied.bbLocationId

  const jitaList = useMemo(() => {
    const totals = new Map<string, number>()
    for (const l of plan?.locations ?? []) {
      for (const p of l.purchases) {
        if (p.channel === 'jita' && !deselected.has(`${l.location_id}:${p.channel}:${p.type_id}`)) {
          totals.set(p.name, (totals.get(p.name) ?? 0) + p.qty)
        }
      }
    }
    return multibuy([...totals].map(([name, qty]) => ({ name, qty })))
  }, [plan, deselected])

  const projectChoices = options?.projects ?? []
  const restorable = plan?.hidden ?? []

  return (
    <div className="v2-buying">
      <div className="v2-board-head">
        <h2>Buying</h2>
        {plan && (
          <p>
            {plan.locations.length ? `${isk(plan.total_cost)} ISK across ${plan.locations.length} location${plan.locations.length === 1 ? '' : 's'}. ` : ''}
            <MarketFreshness lastPoll={plan.generated_at} />
          </p>
        )}
        {jitaList && <CopyButton text={jitaList} label="Copy every Jita item" />}
      </div>

      {/* ── Inputs ── */}
      <div className="v2-top v2-buy-inputs">
        <section className="v2-panel" aria-labelledby="needs-title">
          <h2 id="needs-title">What to cover</h2>

          <div className="v2-field">
            <Switch on={prefs.includeDoctrines} onChange={v => setPrefs({ includeDoctrines: v })} label="Doctrine shortfalls">
              What&apos;s missing from the staging markets
            </Switch>
            {prefs.includeDoctrines && (
              <div className="v2-subfields">
                <div className="v2-tabs" role="tablist" aria-label="Doctrine mode">
                  <button role="tab" aria-selected={prefs.mode === 'fill'} onClick={() => setPrefs({ mode: 'fill' })}>Fill to target</button>
                  <button role="tab" aria-selected={prefs.mode === 'profit'} onClick={() => setPrefs({ mode: 'profit' })}>Seed for profit</button>
                </div>
                <label className="v2-inline">
                  Fill to
                  <input
                    type="number" min={0} max={500} step={10} value={prefs.fillPct} className="v2-qty"
                    onChange={e => setPrefs({ fillPct: Math.max(0, Math.min(500, Number(e.target.value) || 0)) })}
                  />
                  % of target
                </label>
                {prefs.mode === 'profit' && (
                  <label className="v2-inline">
                    What sells within
                    <select value={prefs.windowDays} onChange={e => setPrefs({ windowDays: Number(e.target.value) })} className="v2-select">
                      {[7, 14, 30].map(d => <option key={d} value={d}>{d} days</option>)}
                    </select>
                  </label>
                )}
                <button className="v2-btn" aria-expanded={scopeOpen} onClick={() => setScopeOpen(v => !v)}>
                  {selectedFitIds.length === allFitIds.length ? `All ${allFitIds.length} fits` : `${selectedFitIds.length} of ${allFitIds.length} fits`}
                </button>
                {scopeOpen && options && (
                  <div className="v2-scope-box">
                    <div className="v2-scope-actions">
                      <button className="v2-link" onClick={() => setScopeOff(new Set())}>Select all</button>
                      <button className="v2-link" onClick={() => setScopeOff(new Set(allFitIds))}>Select none</button>
                    </div>
                    <ScopePicker options={options} selection={selection} />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="v2-field">
            <Switch on={prefs.includeProjects} onChange={v => setPrefs({ includeProjects: v })} label="Industry projects">
              Materials for planned and running projects
            </Switch>
            {prefs.includeProjects && (
              <div className="v2-subfields">
                {projectChoices.length === 0 ? (
                  <span className="muted">No active projects.</span>
                ) : projectChoices.map(p => {
                  const on = prefs.projectIds.length === 0 || prefs.projectIds.includes(p.id)
                  return (
                    <button
                      key={p.id} className="v2-chip" aria-pressed={on}
                      onClick={() => {
                        const current = prefs.projectIds.length ? prefs.projectIds : projectChoices.map(x => x.id)
                        const next = on ? current.filter(id => id !== p.id) : [...current, p.id]
                        setPrefs({ projectIds: next.length === projectChoices.length ? [] : next })
                      }}
                    >
                      {p.name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="v2-field">
            <span className="v2-field-label">Want list</span>
            <textarea
              className="v2-textarea" rows={3} value={wantText} onChange={e => setWantText(e.target.value)}
              placeholder={'Item name and quantity, one per line\nTritanium 500000'}
            />
            <label className="v2-inline">
              Deliver to
              <select
                className="v2-select" value={prefs.wantLocationId}
                onChange={e => setPrefs({ wantLocationId: e.target.value ? Number(e.target.value) : '' })}
              >
                <option value="">Choose a location</option>
                {options?.locations.map(l => <option key={l.location_id} value={l.location_id}>{l.location_name}</option>)}
              </select>
            </label>
            {wantText.trim() && !prefs.wantLocationId && <span className="v2-warn-inline">Choose where the want list should be delivered.</span>}
            {plan && plan.want_unknown.length > 0 && <span className="v2-warn-inline">Not recognised: {plan.want_unknown.join(', ')}</span>}
          </div>

          <div className="v2-field">
            <span className="v2-field-label">Options</span>
            <Switch on={prefs.netInventory} onChange={v => setPrefs({ netInventory: v })} label="Subtract what I own">
              Unreserved stock at each location counts toward its needs
            </Switch>
            <Switch on={prefs.useOre} onChange={v => setPrefs({ useOre: v })} label="Allow reprocessing compressed ore">
              Buy ore, ice or gas instead of minerals and moon materials when that&apos;s cheaper
              {options && ` (ore ${+options.ore_efficiency_pct.toFixed(2)}%, gas ${+options.gas_efficiency_pct.toFixed(2)}%)`}
            </Switch>
          </div>
        </section>

        <section className="v2-panel" aria-labelledby="sources-title">
          <h2 id="sources-title">Where to buy</h2>

          <div className="v2-field">
            <Switch on disabled label="Jita">Always on, priced with freight to each location</Switch>
          </div>
          <div className="v2-field">
            <Switch on={prefs.useLocal} onChange={v => setPrefs({ useLocal: v })} label="Local market">
              For projects and the want list. Doctrines never buy locally, since local listings are their stock.
            </Switch>
          </div>

          <div className="v2-field">
            <span className="v2-field-label">Buyback offer</span>
            <textarea
              className="v2-textarea mono" rows={4} value={bbText} onChange={e => setBbText(e.target.value)}
              placeholder={'Paste from Janice: select all rows and copy\nDamage Control II\t10\t50.00\t350000.00\t370000.00'}
            />
            <div className="v2-subfields">
              <div className="v2-tabs" role="tablist" aria-label="Price you pay">
                {(['buy', 'split', 'sell'] as const).map(t => (
                  <button key={t} role="tab" aria-selected={bbPriceType === t} onClick={() => setBbPriceType(t)}>
                    {t === 'buy' ? 'Buy price' : t === 'sell' ? 'Sell price' : 'Split'}
                  </button>
                ))}
              </div>
              <label className="v2-inline">
                Delivered at
                <select className="v2-select" value={bbLocationId} onChange={e => setBbLocationId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">Where it&apos;s needed (no freight)</option>
                  {options?.locations.map(l => <option key={l.location_id} value={l.location_id}>{l.location_name}</option>)}
                </select>
              </label>
            </div>
            <Switch on={prefs.checkFlips} onChange={v => setPrefs({ checkFlips: v })} label="Check the buyback for market flips">
              Items in the offer that nothing above needs, judged as a buy to resell
            </Switch>
            {prefs.checkFlips && (
              <div className="v2-subfields">
                <label className="v2-inline">
                  Resell at
                  <select
                    className="v2-select" value={prefs.flipLocationId}
                    onChange={e => setPrefs({ flipLocationId: e.target.value ? Number(e.target.value) : '' })}
                  >
                    <option value="">Where the offer is delivered</option>
                    {options?.locations.map(l => <option key={l.location_id} value={l.location_id}>{l.location_name}</option>)}
                  </select>
                </label>
                {!prefs.flipLocationId && !bbLocationId && (
                  <span className="v2-warn-inline">Choose a resell location, or where the offer is delivered.</span>
                )}
              </div>
            )}
            {plan && (plan.buyback.parse_errors.length > 0 || plan.buyback.unknown.length > 0) && (
              <span className="v2-warn-inline">
                {[...plan.buyback.parse_errors, ...(plan.buyback.unknown.length ? [`Not recognised: ${plan.buyback.unknown.map(u => u.item_name).join(', ')}`] : [])].join(' ')}
              </span>
            )}
            {plan && plan.buyback.repriced_ore.length > 0 && (
              <span className="muted small">Ore priced by reprocessed value: {plan.buyback.repriced_ore.join(', ')}</span>
            )}
          </div>

          <div className="v2-apply">
            <button
              className="v2-btn primary" disabled={!textDirty}
              onClick={() => setApplied({ want: wantText, bb: bbText, bbPriceType, bbLocationId })}
            >
              Update plan with want list and offer
            </button>
          </div>
        </section>
      </div>

      {/* ── Results ── */}
      <div className={`v2-buy-results${loading ? ' is-loading' : ''}`}>
        {error ? (
          <p className="v2-calm">{error}</p>
        ) : !plan ? (
          <div className="v2-skeleton" aria-busy="true" />
        ) : plan.locations.length === 0 ? (
          <p className="v2-calm">
            Nothing to buy. Every selected need is already covered by the market{prefs.netInventory ? ' or what you own' : ''}.
          </p>
        ) : (
          plan.locations.map(l => (
            <LocationResult
              key={l.location_id} plan={l} onQty={onQty}
              onExclude={t => setExcluded(new Set(excluded).add(t))}
              deselected={deselected} onToggle={togglePurchases}
            />
          ))
        )}

        {plan && (restorable.length > 0 || Object.keys(overrides).length > 0 || excluded.size > 0) && (
          <div className="v2-restore">
            {restorable.map(h => (
              <button
                key={`${h.location_id}-${h.type_id}`} className="v2-chip"
                onClick={() => {
                  const ex = new Set(excluded); ex.delete(h.type_id); setExcluded(ex)
                  onQty(`${h.location_id}:${h.type_id}`, null)
                }}
                title="Buy this again"
              >
                {h.name} ↺
              </button>
            ))}
            {(Object.keys(overrides).length > 0 || excluded.size > 0) && (
              <button className="v2-link" onClick={() => { setOverrides({}); setExcluded(new Set()) }}>
                Reset all quantity changes and removed items
              </button>
            )}
          </div>
        )}

        {plan && plan.no_sales.length > 0 && (
          <p className="muted small">
            Left out because they don&apos;t sell locally: {plan.no_sales.map(n => n.name).join(', ')}.
          </p>
        )}

        {plan?.flip && (plan.flip.recommended.length + plan.flip.unprofitable.length + plan.flip.unpriced.length > 0) && (
          <section className="v2-buy-loc" aria-labelledby="flip-title">
            <div className="v2-buy-loc-head">
              <h3 id="flip-title">Market flips in the buyback offer</h3>
              <p>Items nothing above needs, priced as a buy to resell at {plan.flip.location_name}.</p>
              {plan.flip.recommended.length > 0 && (
                <CopyButton text={multibuy(plan.flip.recommended)} label="Copy profitable items" />
              )}
            </div>
            <table className="v2-table compact">
              <thead>
                <tr>
                  <Th label="Item" k="item" sort={flipSort} defaultDir="asc" />
                  <Th label="Qty" k="qty" sort={flipSort} align="right" />
                  <Th label="Offer" k="offer" sort={flipSort} align="right" />
                  <Th label="Sells for" k="sells" sort={flipSort} align="right" />
                  <Th label="Profit" k="profit" sort={flipSort} align="right" />
                  <Th label="Sells per day" k="velocity" sort={flipSort} align="right" />
                </tr>
              </thead>
              <tbody>
                {sortRows([...plan.flip.recommended, ...plan.flip.unprofitable, ...plan.flip.unpriced], flipSort, (e, k) => {
                  switch (k) {
                    case 'item': return e.name
                    case 'qty': return e.qty
                    case 'offer': return e.unit_price
                    case 'sells': return e.sell_price
                    case 'profit': return e.total_profit
                    case 'velocity': return e.velocity_daily
                  }
                }).map(e => {
                  const tone = e.total_profit == null ? 'is-unset' : e.total_profit > 0 ? 'is-ready' : 'is-short'
                  return (
                    <tr key={e.type_id} className={tone}>
                      <td><span className="dot" aria-hidden /><Link href={`/v2/items/${e.type_id}`} className="name">{e.name}</Link></td>
                      <td className="num">{e.qty.toLocaleString()}</td>
                      <td className="num muted">{isk(e.unit_price)}</td>
                      <td className="num muted">{e.sell_price != null ? isk(e.sell_price) : 'not on market'}</td>
                      <td className="num">
                        {e.total_profit != null
                          ? <b>{isk(e.total_profit)}{e.profit_pct != null && <span className="muted"> ({e.profit_pct.toFixed(0)}%)</span>}</b>
                          : <span className="muted">–</span>}
                      </td>
                      <td className="num muted">{e.velocity_daily ?? '–'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  )
}
