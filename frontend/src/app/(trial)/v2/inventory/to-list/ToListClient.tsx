'use client'

import { useEffect, useMemo, useState } from 'react'
import { isk } from '../../_shared/doctrines'
import { Th, sortRows, useSort } from '../../_shared/sort'
import { CopyButton } from '../../_shared/ui'
import {
  AutoReason, Notation, PriceRange, autoPrice, importText, nearestTick, priceForProfit, profitPerUnit,
} from './listPricing'

interface StockItem {
  type_id: number
  name: string
  qty: number
  unit_value: number
  local_sell: number | null
  on_market_listings: { qty: number; list_price: number }[]
}
interface StockLocation {
  location_id: number
  location_name: string
  fees: { broker_fee_pct: number; sales_tax_pct: number; scc_surcharge_pct: number }
  items: StockItem[]
}

type Choice = { mode: 'auto' } | { mode: 'pct'; pct: number } | { mode: 'manual'; price: number }

const PRESETS = [5, 10, 15]
const AUTO: Choice = { mode: 'auto' }
const SETTINGS_KEY = 'v2-to-list'

const REASON_TEXT: Record<AutoReason, string> = {
  'undercut': 'Undercuts the lowest order',
  'own-low': 'Matches your own lowest order',
  'ceiling': 'Market is above your range, held at the top of it',
  'floor': 'Undercutting would fall below your range, held at the bottom of it',
  'no-market': 'No orders here, listed at the top of your range',
  'no-price': 'No cost or market price, enter one',
}

function num(n: number | null | undefined): string {
  return n == null ? '–' : n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function parseIsk(text: string): number {
  const t = text.trim().replace(/\s/g, '')
  const normal = /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
  return Number(normal)
}

function loadSettings(): { range: PriceRange; notation: Notation; locationId: number | null } {
  const fallback = { range: { minPct: 5, maxPct: 15 }, notation: 'point' as Notation, locationId: null }
  try {
    const saved = localStorage.getItem(SETTINGS_KEY)
    return saved ? { ...fallback, ...JSON.parse(saved) } : fallback
  } catch { return fallback }
}

function PriceInput({ value, label, onCommit }: { value: number | null; label: string; onCommit: (price: number) => void }) {
  const shown = value == null ? '' : num(value)
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const commit = () => {
    const parsed = parseIsk(draft)
    if (parsed > 0) onCommit(nearestTick(parsed))
    else setDraft(shown)
  }
  return (
    <input
      className="v2-qty v2-price" inputMode="decimal" aria-label={label} value={draft}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
    />
  )
}

type PickKey = 'item' | 'qty' | 'cost' | 'low' | 'margin'

export function ToListClient() {
  const [locations, setLocations] = useState<StockLocation[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [locationId, setLocationId] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [step, setStep] = useState<'pick' | 'price'>('pick')
  const [choices, setChoices] = useState<Record<number, Choice>>({})
  const [range, setRange] = useState<PriceRange>({ minPct: 5, maxPct: 15 })
  const [notation, setNotation] = useState<Notation>('point')
  const sort = useSort<PickKey>('item', 'asc')

  useEffect(() => {
    const saved = loadSettings()
    setRange(saved.range)
    setNotation(saved.notation)
    fetch('/api/inventory')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then((all: StockLocation[]) => {
        const usable = all
          .map(l => ({ ...l, items: l.items.filter(i => i.qty > 0) }))
          .filter(l => l.items.length > 0)
        setLocations(usable)
        const remembered = usable.find(l => l.location_id === saved.locationId)
        const first = remembered ?? usable.find(l => !l.location_name.startsWith('Jita')) ?? usable[0]
        setLocationId(first?.location_id ?? null)
      })
      .catch(() => setFailed(true))
  }, [])

  useEffect(() => {
    if (locationId == null) return
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ range, notation, locationId })) } catch {}
  }, [range, notation, locationId])

  const location = locations?.find(l => l.location_id === locationId) ?? null
  const feeFrac = location
    ? (location.fees.broker_fee_pct + location.fees.sales_tax_pct + location.fees.scc_surcharge_pct) / 100
    : 0

  const pricingFor = (item: StockItem) => ({
    cost: item.unit_value,
    low: item.local_sell,
    ownPrices: item.on_market_listings.map(l => l.list_price),
    feeFrac,
  })

  const rows = useMemo(() => {
    if (!location) return []
    return location.items.filter(i => selected.has(i.type_id)).map(item => {
      const choice = choices[item.type_id] ?? AUTO
      const auto = autoPrice(pricingFor(item), range)
      const price = choice.mode === 'manual' ? choice.price
        : choice.mode === 'pct' ? priceForProfit(item.unit_value, choice.pct, feeFrac)
        : auto.price
      const profit = price == null ? null : profitPerUnit(price, item.unit_value, feeFrac)
      const pct = profit != null && item.unit_value > 0 ? (profit / item.unit_value) * 100 : null
      return { item, choice, price, profit, pct, reason: auto.reason }
    })
    // pricingFor only depends on feeFrac, listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, selected, choices, range, feeFrac])

  const pickRows = useMemo(() => sortRows(location?.items ?? [], sort, (item, key) => {
    switch (key) {
      case 'item': return item.name
      case 'qty': return item.qty
      case 'cost': return item.unit_value
      case 'low': return item.local_sell
      case 'margin': return item.local_sell != null && item.unit_value > 0
        ? (profitPerUnit(item.local_sell, item.unit_value, feeFrac) / item.unit_value) * 100 : null
    }
  }), [location, sort, feeFrac])

  const setChoice = (typeId: number, choice: Choice) => setChoices(c => ({ ...c, [typeId]: choice }))
  const setAll = (choice: Choice) => setChoices(Object.fromEntries(rows.map(r => [r.item.type_id, choice])))
  const toggle = (typeId: number, on: boolean) => setSelected(s => {
    const next = new Set(s)
    if (on) next.add(typeId); else next.delete(typeId)
    return next
  })
  const changeLocation = (id: number) => {
    setLocationId(id); setSelected(new Set()); setChoices({}); setStep('pick')
  }
  const setBound = (key: keyof PriceRange, text: string) =>
    setRange(r => ({ ...r, [key]: Math.max(0, Number(text) || 0) }))

  if (failed) return <p className="v2-warn">Couldn&apos;t load your inventory. Reload to try again.</p>
  if (!locations) return <p className="muted">Loading stock…</p>
  if (!location) return <p className="v2-calm">No unlisted stock at any station.</p>

  const priced = rows.filter(r => r.price != null) as (typeof rows[number] & { price: number; profit: number })[]
  const unpriced = rows.length - priced.length
  const belowCost = priced.filter(r => r.item.unit_value > 0 && r.profit < 0).length
  const totalValue = priced.reduce((s, r) => s + r.price * r.item.qty, 0)
  const totalProfit = priced.reduce((s, r) => s + (r.item.unit_value > 0 ? r.profit * r.item.qty : 0), 0)
  const output = importText(priced.map(r => ({ name: r.item.name, price: r.price })), notation)
  const allOn = selected.size === location.items.length
  const allAuto = rows.every(r => r.choice.mode === 'auto')
  const allAtPct = (p: number) => rows.length > 0 && rows.every(r => r.choice.mode === 'pct' && r.choice.pct === p)

  return (
    <div className="v2-tolist">
      <div className="v2-tolist-bar">
        <label className="v2-inline">
          Station
          <select className="v2-select" value={location.location_id} onChange={e => changeLocation(Number(e.target.value))}>
            {locations.map(l => <option key={l.location_id} value={l.location_id}>{l.location_name}</option>)}
          </select>
        </label>
        <span className="muted">
          Fees {(feeFrac * 100).toFixed(2)}%
        </span>
        <span className="v2-tolist-spacer" />
        {step === 'pick'
          ? <button className="v2-btn primary" disabled={selected.size === 0} onClick={() => setStep('price')}>
              Set prices ({selected.size})
            </button>
          : <button className="v2-btn" onClick={() => setStep('pick')}>Back to selection</button>}
      </div>

      {step === 'pick' && (
        <div className="v2-table-wrap">
          <table className="v2-table compact">
            <thead>
              <tr>
                <th className="sel">
                  <input
                    type="checkbox" className="v2-check" checked={allOn} aria-label="Select every item"
                    ref={el => { if (el) el.indeterminate = selected.size > 0 && !allOn }}
                    onChange={() => setSelected(allOn ? new Set() : new Set(location.items.map(i => i.type_id)))}
                  />
                </th>
                <Th label="Item" k="item" sort={sort} defaultDir="asc" />
                <Th label="Qty" k="qty" sort={sort} align="right" title="In stock, not reserved and not already on the market" />
                <Th label="Your cost" k="cost" sort={sort} align="right" title="Average cost per unit of the stock here" />
                <Th label="Lowest order" k="low" sort={sort} align="right" title="Lowest sell order at this station, from the last market poll" />
                <Th label="Profit at lowest" k="margin" sort={sort} align="right" title="Profit on cost if sold at the lowest order, after fees" />
              </tr>
            </thead>
            <tbody>
              {pickRows.map(item => {
                const margin = item.local_sell != null && item.unit_value > 0
                  ? (profitPerUnit(item.local_sell, item.unit_value, feeFrac) / item.unit_value) * 100 : null
                return (
                  <tr key={item.type_id}>
                    <td className="sel">
                      <input
                        type="checkbox" className="v2-check" checked={selected.has(item.type_id)}
                        aria-label={`Select ${item.name}`} onChange={e => toggle(item.type_id, e.target.checked)}
                      />
                    </td>
                    <td>{item.name}{item.on_market_listings.length > 0 && <span className="muted"> · some already listed</span>}</td>
                    <td className="num">{item.qty.toLocaleString('en-US')}</td>
                    <td className="num">{item.unit_value > 0 ? num(item.unit_value) : '–'}</td>
                    <td className="num muted">{num(item.local_sell)}</td>
                    <td className="num">
                      {margin == null ? '–' : <span className={margin >= 0 ? 'up' : 'down'}>{margin.toFixed(1)}%</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {step === 'price' && (
        <>
          <div className="v2-tolist-bar">
            <label className="v2-inline">
              Profit range
              <input type="number" min={0} className="v2-qty" aria-label="Minimum profit percent" value={range.minPct} onChange={e => setBound('minPct', e.target.value)} />
              to
              <input type="number" min={0} className="v2-qty" aria-label="Maximum profit percent" value={range.maxPct} onChange={e => setBound('maxPct', e.target.value)} />
              %
            </label>
            <div className="v2-price-opts" role="group" aria-label="Set price for every item">
              <span className="muted">All items:</span>
              <button className="v2-chip" aria-pressed={allAuto} onClick={() => setAll(AUTO)}>Undercut</button>
              {PRESETS.map(p => (
                <button key={p} className="v2-chip" aria-pressed={allAtPct(p)} onClick={() => setAll({ mode: 'pct', pct: p })}>+{p}%</button>
              ))}
            </div>
          </div>

          <div className="v2-table-wrap">
            <table className="v2-table compact">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Qty</th>
                  <th className="num">Your cost</th>
                  <th className="num">Lowest order</th>
                  <th>Price by</th>
                  <th className="num">List price</th>
                  <th className="num" title="Per unit, after broker fee, sales tax and SCC">Profit/unit</th>
                  <th className="num">Profit %</th>
                  <th className="num">Total profit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ item, choice, price, profit, pct, reason }) => {
                  const noCost = item.unit_value <= 0
                  const customPct = choice.mode === 'pct' && !PRESETS.includes(choice.pct) ? choice.pct : ''
                  return (
                    <tr key={item.type_id}>
                      <td>
                        {item.name}
                        {choice.mode === 'auto' && <div className={`v2-tolist-note${reason === 'floor' || reason === 'no-price' ? ' warn' : ''}`}>{REASON_TEXT[reason]}</div>}
                      </td>
                      <td className="num">{item.qty.toLocaleString('en-US')}</td>
                      <td className="num">{noCost ? '–' : num(item.unit_value)}</td>
                      <td className="num muted">{num(item.local_sell)}</td>
                      <td>
                        <div className="v2-price-opts">
                          <button className="v2-chip" aria-pressed={choice.mode === 'auto'} onClick={() => setChoice(item.type_id, AUTO)}>Undercut</button>
                          {PRESETS.map(p => (
                            <button key={p} className="v2-chip" disabled={noCost} aria-pressed={choice.mode === 'pct' && choice.pct === p} onClick={() => setChoice(item.type_id, { mode: 'pct', pct: p })}>+{p}%</button>
                          ))}
                          <input
                            type="number" min={0} className="v2-qty" placeholder="%" disabled={noCost}
                            aria-label={`Custom profit percent for ${item.name}`} value={customPct}
                            onChange={e => setChoice(item.type_id, e.target.value === '' ? AUTO : { mode: 'pct', pct: Math.max(0, Number(e.target.value) || 0) })}
                          />
                        </div>
                      </td>
                      <td className="num">
                        <PriceInput value={price} label={`List price for ${item.name}`} onCommit={p => setChoice(item.type_id, { mode: 'manual', price: p })} />
                      </td>
                      <td className="num">{noCost || profit == null ? '–' : <span className={profit >= 0 ? 'up' : 'down'}>{num(profit)}</span>}</td>
                      <td className="num">{pct == null ? '–' : <span className={pct >= 0 ? 'up' : 'down'}>{pct.toFixed(1)}%</span>}</td>
                      <td className="num">{noCost || profit == null ? '–' : <span className={profit >= 0 ? 'up' : 'down'}>{isk(profit * item.qty)}</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="v2-tolist-bar">
            <span>
              {priced.length} items, {isk(totalValue)} listed,{' '}
              <span className={totalProfit >= 0 ? 'up' : 'down'}>{totalProfit >= 0 ? '+' : ''}{isk(totalProfit)} profit</span>
            </span>
            {belowCost > 0 && <span className="v2-warn-inline">{belowCost} below cost</span>}
            {unpriced > 0 && <span className="v2-warn-inline">{unpriced} without a price, left out</span>}
          </div>

          <div className="v2-tolist-bar">
            <h4 className="v2-field-label">Import prices</h4>
            <div className="v2-tabs" role="tablist" aria-label="Decimal notation">
              <button role="tab" aria-selected={notation === 'point'} onClick={() => setNotation('point')}>1,234.56</button>
              <button role="tab" aria-selected={notation === 'comma'} onClick={() => setNotation('comma')}>1.234,56</button>
            </div>
            <span className="v2-tolist-spacer" />
            <CopyButton text={output} label="Copy for EVE" primary />
          </div>
          <textarea className="v2-textarea" readOnly rows={Math.min(12, Math.max(3, priced.length))} value={output} aria-label="Text to paste into EVE" />
        </>
      )}
    </div>
  )
}
