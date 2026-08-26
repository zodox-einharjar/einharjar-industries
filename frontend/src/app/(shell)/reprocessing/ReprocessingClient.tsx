'use client'

import { useEffect, useRef, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ItemLine {
  type_id: number
  name: string
  mode: 'reprocess' | 'direct'
  qty: number
  unit_price: number
  line_cost: number
}

interface MineralLine {
  type_id: number
  name: string
  qty_needed: number
  qty_produced: number
  surplus: number
}

interface UnmetMineral {
  type_id: number
  name: string
  qty_needed: number
  qty_produced: number
  shortfall: number
}

interface UnpricedItem {
  type_id: number
  name: string
  qty: number
}

interface UnknownItem {
  item_name: string
  qty: number
}

interface OptimizeResponse {
  items_to_buy: ItemLine[]
  total_cost: number
  minerals: MineralLine[]
  unmet_minerals: UnmetMineral[]
  efficiency_pct: number
  gas_efficiency_pct: number
  unpriced: UnpricedItem[]
  unknown: UnknownItem[]
  parse_errors: string[]
  mineral_unresolved: string[]
}

interface Location {
  id: number
  name: string
}

interface Candidate {
  type_id: number
  name: string
  qty_available: number
  unit_cost: number
  portion_size: number
}

interface JobInput {
  type_id: number
  name: string
  qty_requested: number
  qty_consumed: number
  qty_leftover: number
  unit_cost: number
  line_cost: number
}

interface JobOutput {
  type_id: number
  name: string
  qty: number
  reference_price: number
  reference_value: number
  value_share_pct: number
  allocated_cost: number
  unit_cost: number
}

interface JobResult {
  ok: boolean
  errors?: string[]
  location_name?: string
  inputs?: JobInput[]
  outputs?: JobOutput[]
  total_input_cost?: number
  fee_pct?: number
  fee_isk?: number
  total_output_reference_value?: number
  total_cost_to_allocate?: number
  efficiency_pct?: number
  gas_efficiency_pct?: number
}

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

async function errorMessage(res: Response, fallback: string): Promise<string> {
  // The backend normally returns JSON, but a proxy/server error (502, an
  // unhandled exception, etc.) can return plain text or HTML instead —
  // res.json() would throw a confusing "Unexpected token" error in that case.
  const raw = await res.text()
  try {
    const parsed = JSON.parse(raw)
    return parsed.detail || fallback
  } catch {
    return raw.trim() ? `${fallback} (server said: ${raw.slice(0, 200)})` : fallback
  }
}

const PRICE_TYPES = [
  { value: 'buy'   as const, label: 'Buy price'  },
  { value: 'sell'  as const, label: 'Sell price' },
  { value: 'split' as const, label: 'Split'      },
]

const MODE_LABEL: Record<ItemLine['mode'], string> = { reprocess: 'Reprocess', direct: 'Direct buy' }

const TD = 'px-3 py-2 align-middle'
const TH = 'px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider whitespace-nowrap'
const BTN_SM = 'px-3 py-1 text-[12px] border border-wire text-muted hover:text-primary hover:border-secondary rounded transition-colors'
const BTN_SM_PRIMARY = 'px-3 py-1 text-[12px] border border-accent text-accent hover:bg-accent hover:text-canvas rounded transition-colors disabled:opacity-40 disabled:pointer-events-none'

// ── Buy planner tab ──────────────────────────────────────────────────────────────

function BuyPlannerTab() {
  const [step, setStep] = useState<'form' | 'results'>('form')
  const [mineralsText, setMineralsText] = useState('')
  const [supplyText, setSupplyText] = useState('')
  const [priceType, setPriceType] = useState<'buy' | 'sell' | 'split'>('sell')
  const [efficiency, setEfficiency] = useState(90.63)
  const [gasEfficiency, setGasEfficiency] = useState(90.0)
  const [result, setResult] = useState<OptimizeResponse | null>(null)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mineralsRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.reprocessing_efficiency_pct) setEfficiency(d.reprocessing_efficiency_pct)
        if (d?.reprocessing_gas_efficiency_pct) setGasEfficiency(d.reprocessing_gas_efficiency_pct)
      })
      .catch(() => {})
    mineralsRef.current?.focus()
  }, [])

  async function handleOptimize() {
    if (!mineralsText.trim() || !supplyText.trim()) return
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/reprocessing/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          minerals_text: mineralsText.trim(),
          supply_text: supplyText.trim(),
          price_type: priceType,
          efficiency_pct: efficiency,
          gas_efficiency_pct: gasEfficiency,
        }),
      })
      if (!res.ok) throw new Error(await errorMessage(res, 'Optimization failed'))
      setResult(await res.json())
      setStep('results')
    } catch (e: any) {
      setError(e.message || 'Failed to optimize')
    } finally {
      setLoading(false)
    }
  }

  async function copyList() {
    if (!result || result.items_to_buy.length === 0) return
    await copyText(buildMultibuy(result.items_to_buy.map(o => ({ name: o.name, qty: o.qty }))))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function reset() {
    setResult(null); setStep('form'); setError(null)
  }

  if (step === 'form') return (
    <div className="max-w-2xl space-y-4">
      {error && <p className="text-[12px] text-eve-red">{error}</p>}

      <div>
        <label className="block text-[11px] text-muted mb-1.5">
          Minerals needed — one per line, <span className="font-mono text-faint">Name  Qty</span>
        </label>
        <textarea
          ref={mineralsRef}
          value={mineralsText}
          onChange={e => setMineralsText(e.target.value)}
          rows={6}
          placeholder={'Tritanium 5000000\nPyerite 150000'}
          className="w-full bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary placeholder:text-faint focus:outline-none focus:border-accent resize-none"
        />
      </div>

      <div>
        <label className="block text-[11px] text-muted mb-1.5">
          Available ore and/or minerals — Janice paste (select all rows, copy). Include raw minerals
          here too if you can buy them directly — the optimizer will compare buying ore-and-reprocess
          against buying the mineral outright (or a mix of both).<br />
          Expected columns: <span className="text-faint font-mono">Name · Qty · Volume · Buy price · Sell price</span>
        </label>
        <textarea
          value={supplyText}
          onChange={e => setSupplyText(e.target.value)}
          rows={10}
          placeholder={"Compressed Veldspar\t1000000\t0.00\t1.50\t1.80\nTritanium\t5000000\t0.01\t3.00\t3.20"}
          className="w-full bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary placeholder:text-faint focus:outline-none focus:border-accent resize-none"
        />
      </div>

      <div className="flex gap-3">
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
        <div>
          <label className="block text-[11px] text-muted mb-1.5">Ore/ice efficiency</label>
          <div className="flex items-center gap-1.5">
            <input
              type="number" step="0.0001" min="0" max="100"
              value={efficiency}
              onChange={e => setEfficiency(Number(e.target.value))}
              className="w-28 bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
            />
            <span className="text-[13px] text-muted">%</span>
          </div>
        </div>
        <div>
          <label className="block text-[11px] text-muted mb-1.5">Gas efficiency</label>
          <div className="flex items-center gap-1.5">
            <input
              type="number" step="0.0001" min="0" max="100"
              value={gasEfficiency}
              onChange={e => setGasEfficiency(Number(e.target.value))}
              className="w-28 bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
            />
            <span className="text-[13px] text-muted">%</span>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button onClick={handleOptimize} disabled={!mineralsText.trim() || !supplyText.trim() || loading} className={BTN_SM_PRIMARY}>
          {loading ? 'Solving…' : 'Find cheapest combination'}
        </button>
      </div>
    </div>
  )

  // step === 'results'
  if (!result) return null

  const hasErrors = result.parse_errors.length > 0 || result.unknown.length > 0 ||
    result.unpriced.length > 0 || result.mineral_unresolved.length > 0

  return (
    <div className="space-y-4">
      {error && <p className="text-[12px] text-eve-red">{error}</p>}
      <div className="flex items-center justify-between">
        <div className="text-[13px] text-primary">
          {result.items_to_buy.length} item{result.items_to_buy.length !== 1 ? 's' : ''} to buy ·{' '}
          <span className="text-eve-green">{iska(result.total_cost)} ISK total</span> ·{' '}
          <span className="text-muted">{result.efficiency_pct.toFixed(4)}% ore/ice · {result.gas_efficiency_pct.toFixed(4)}% gas</span>
          {result.unmet_minerals.length > 0 && (
            <span className="text-eve-red"> · {result.unmet_minerals.length} mineral{result.unmet_minerals.length !== 1 ? 's' : ''} short</span>
          )}
        </div>
        <button onClick={reset} className={BTN_SM}>← New calculation</button>
      </div>

      {result.unmet_minerals.length > 0 && (
        <div className="bg-eve-red/10 border border-eve-red/30 rounded p-3 text-[12px] text-eve-red space-y-1">
          {result.unmet_minerals.map(m => (
            <div key={m.type_id}>
              <strong>{m.name}</strong>: short by {m.shortfall.toLocaleString()} — the pasted list
              can't produce more than {m.qty_produced.toLocaleString()} of the {m.qty_needed.toLocaleString()} needed.
            </div>
          ))}
        </div>
      )}

      <div className="border border-wire rounded overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-hi border-b border-wire">
            <tr>
              <th className={`${TH} text-left`}>Item to buy</th>
              <th className={`${TH} text-left`}>Method</th>
              <th className={`${TH} text-right`}>Qty</th>
              <th className={`${TH} text-right`}>Unit price</th>
              <th className={`${TH} text-right`}>Line cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-wire">
            {result.items_to_buy.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted">Nothing to buy</td></tr>
            ) : result.items_to_buy.map(o => (
              <tr key={`${o.type_id}-${o.mode}`}>
                <td className={`${TD} text-primary`}>{o.name}</td>
                <td className={`${TD} text-muted`}>{MODE_LABEL[o.mode]}</td>
                <td className={`${TD} text-right font-mono text-secondary`}>{o.qty.toLocaleString()}</td>
                <td className={`${TD} text-right font-mono text-muted`}>{iska(o.unit_price)}</td>
                <td className={`${TD} text-right font-mono font-semibold text-primary`}>{iska(o.line_cost)}</td>
              </tr>
            ))}
          </tbody>
          {result.items_to_buy.length > 0 && (
            <tfoot className="border-t border-wire">
              <tr>
                <td colSpan={4} className={`${TD} text-right text-muted`}>Total</td>
                <td className={`${TD} text-right font-mono font-semibold text-eve-green`}>{iska(result.total_cost)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="border border-wire rounded overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-hi border-b border-wire">
            <tr>
              <th className={`${TH} text-left`}>Mineral</th>
              <th className={`${TH} text-right`}>Needed</th>
              <th className={`${TH} text-right`}>Produced</th>
              <th className={`${TH} text-right`}>Surplus</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-wire">
            {result.minerals.map(m => {
              const short = m.qty_produced < m.qty_needed
              return (
                <tr key={m.type_id} className={short ? 'bg-eve-red/5' : ''}>
                  <td className={`${TD} text-primary`}>{m.name}</td>
                  <td className={`${TD} text-right font-mono text-secondary`}>{m.qty_needed.toLocaleString()}</td>
                  <td className={`${TD} text-right font-mono ${short ? 'text-eve-red' : 'text-eve-green'}`}>{m.qty_produced.toLocaleString()}</td>
                  <td className={`${TD} text-right font-mono text-muted`}>{m.surplus > 0 ? `+${m.surplus.toLocaleString()}` : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {hasErrors && (
        <div className="space-y-3">
          {result.mineral_unresolved.length > 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-eve-red hover:text-secondary">{result.mineral_unresolved.length} unresolved mineral line{result.mineral_unresolved.length !== 1 ? 's' : ''}</summary>
              <div className="mt-2 space-y-0.5 pl-3">
                {result.mineral_unresolved.map((line, i) => <div key={i} className="text-faint">{line}</div>)}
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
          {result.unpriced.length > 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-muted hover:text-secondary">{result.unpriced.length} item{result.unpriced.length !== 1 ? 's' : ''} with no price</summary>
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
          {result.parse_errors.length > 0 && (
            <div className="space-y-0.5">
              {result.parse_errors.map((e, i) => <p key={i} className="text-[11px] text-eve-amber">{e}</p>)}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={copyList} disabled={result.items_to_buy.length === 0} className={BTN_SM}>
          {copied ? '✓ Copied' : 'Copy to Multibuy'}
        </button>
      </div>
    </div>
  )
}

// ── Reprocess inventory tab ───────────────────────────────────────────────────────

function ReprocessInventoryTab() {
  const [step, setStep] = useState<'select' | 'preview' | 'done'>('select')
  const [locations, setLocations] = useState<Location[]>([])
  const [locationId, setLocationId] = useState<number | ''>('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [qtyByType, setQtyByType] = useState<Record<number, number>>({})
  const [pasteText, setPasteText] = useState('')
  const [pasteWarnings, setPasteWarnings] = useState<string[]>([])
  const [efficiency, setEfficiency] = useState(90.63)
  const [gasEfficiency, setGasEfficiency] = useState(90.0)
  const [feePct, setFeePct] = useState(0)
  const [result, setResult] = useState<JobResult | null>(null)
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/locations').then(r => r.ok ? r.json() : []).then(setLocations)
    fetch('/api/settings')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.reprocessing_efficiency_pct) setEfficiency(d.reprocessing_efficiency_pct)
        if (d?.reprocessing_gas_efficiency_pct) setGasEfficiency(d.reprocessing_gas_efficiency_pct)
        if (d?.reprocessing_fee_pct != null) setFeePct(d.reprocessing_fee_pct)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!locationId) { setCandidates([]); setSelected(new Set()); setQtyByType({}); setPasteText(''); setPasteWarnings([]); return }
    setLoadingCandidates(true); setError(null)
    fetch(`/api/reprocessing/inventory-candidates?location_id=${locationId}`)
      .then(async r => { if (!r.ok) throw new Error(await errorMessage(r, 'Failed to load inventory')); return r.json() })
      .then(d => {
        setCandidates(d.candidates)
        setQtyByType(Object.fromEntries(d.candidates.map((c: Candidate) => [c.type_id, c.qty_available])))
        setSelected(new Set())
        setPasteText('')
        setPasteWarnings([])
      })
      .catch(e => setError(e.message || 'Failed to load inventory'))
      .finally(() => setLoadingCandidates(false))
  }, [locationId])

  function toggleSelect(type_id: number) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(type_id) ? next.delete(type_id) : next.add(type_id)
      return next
    })
  }

  function setQty(type_id: number, qty: number, max: number) {
    setQtyByType(prev => ({ ...prev, [type_id]: Math.max(0, Math.min(qty, max)) }))
  }

  // "Name<tab or space>Qty" per line — same convention as the mineral/want-list paste
  // boxes elsewhere in the app, so a copy out of the EVE inventory window just works.
  function parsePasteLine(line: string): { name: string; qty: number } | null {
    let parts = line.split('\t').map(p => p.trim()).filter(p => p !== '')
    if (parts.length < 2) {
      const m = line.match(/^(.*\S)\s+([\d,]+)\s*$/)
      if (!m) return null
      parts = [m[1], m[2]]
    }
    const name = parts[0]
    const qty = parseInt(parts[1].replace(/,/g, ''), 10)
    if (!name || Number.isNaN(qty)) return null
    return { name, qty }
  }

  function handlePasteMatch() {
    const byName = new Map(candidates.map(c => [c.name.toLowerCase(), c]))
    const warnings: string[] = []
    const newSelected = new Set<number>()
    const newQty: Record<number, number> = {}

    for (const raw of pasteText.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const parsed = parsePasteLine(line)
      if (!parsed) { warnings.push(`Couldn't parse line: "${line}"`); continue }
      const cand = byName.get(parsed.name.toLowerCase())
      if (!cand) { warnings.push(`Not in your inventory here: ${parsed.name}`); continue }
      if (parsed.qty > cand.qty_available) {
        warnings.push(`${cand.name}: pasted ${parsed.qty.toLocaleString()}, only ${cand.qty_available.toLocaleString()} available — capped`)
      }
      newSelected.add(cand.type_id)
      newQty[cand.type_id] = Math.max(0, Math.min(parsed.qty, cand.qty_available))
    }

    setSelected(newSelected)
    setQtyByType(prev => ({ ...prev, ...newQty }))
    setPasteWarnings(warnings)
  }

  const selectedItems = candidates
    .filter(c => selected.has(c.type_id) && (qtyByType[c.type_id] ?? 0) > 0)
    .map(c => ({ type_id: c.type_id, qty: qtyByType[c.type_id] ?? 0 }))

  async function handlePreview() {
    if (!locationId || selectedItems.length === 0) return
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/reprocessing/inventory-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId, items: selectedItems,
          efficiency_pct: efficiency, gas_efficiency_pct: gasEfficiency, fee_pct: feePct,
        }),
      })
      if (!res.ok) throw new Error(await errorMessage(res, 'Preview failed'))
      const data: JobResult = await res.json()
      if (!data.ok) { setError((data.errors || []).join('; ')); return }
      setResult(data)
      setStep('preview')
    } catch (e: any) {
      setError(e.message || 'Failed to preview')
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirm() {
    if (!locationId || selectedItems.length === 0) return
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/reprocessing/inventory-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: locationId, items: selectedItems,
          efficiency_pct: efficiency, gas_efficiency_pct: gasEfficiency, fee_pct: feePct,
        }),
      })
      if (!res.ok) throw new Error(await errorMessage(res, 'Confirm failed'))
      const data: JobResult = await res.json()
      setResult(data)
      setStep('done')
    } catch (e: any) {
      setError(e.message || 'Failed to reprocess')
    } finally {
      setLoading(false)
    }
  }

  function reset() {
    setResult(null); setStep('select'); setError(null)
    setSelected(new Set())
    fetch('/api/locations').then(r => r.ok ? r.json() : []).then(setLocations)
  }

  if (step === 'done' && result) return (
    <div className="py-8 space-y-4 max-w-2xl">
      <p className="text-[13px] text-eve-green">
        Reprocessed — inventory updated at {result.location_name}.
      </p>
      <div className="border border-wire rounded overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-hi border-b border-wire">
            <tr>
              <th className={`${TH} text-left`}>Mineral</th>
              <th className={`${TH} text-right`}>Qty</th>
              <th className={`${TH} text-right`}>Unit cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-wire">
            {(result.outputs || []).map(o => (
              <tr key={o.type_id}>
                <td className={`${TD} text-primary`}>{o.name}</td>
                <td className={`${TD} text-right font-mono text-eve-green`}>{o.qty.toLocaleString()}</td>
                <td className={`${TD} text-right font-mono text-muted`}>{iska(o.unit_cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={reset} className={BTN_SM_PRIMARY}>Reprocess more</button>
    </div>
  )

  if (step === 'preview' && result) return (
    <div className="space-y-4">
      {error && <p className="text-[12px] text-eve-red">{error}</p>}
      <div className="flex items-center justify-between">
        <div className="text-[13px] text-primary">
          {result.location_name} · <span className="text-muted">{(result.efficiency_pct ?? 0).toFixed(4)}% ore/ice · {(result.gas_efficiency_pct ?? 0).toFixed(4)}% gas</span>
          {(result.fee_pct ?? 0) > 0 && <span className="text-muted"> · {result.fee_pct}% station fee ({iska(result.fee_isk)})</span>}
        </div>
        <button onClick={() => setStep('select')} className={BTN_SM}>← Back</button>
      </div>

      <div className="border border-wire rounded overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-hi border-b border-wire">
            <tr>
              <th className={`${TH} text-left`}>Consuming</th>
              <th className={`${TH} text-right`}>Qty</th>
              <th className={`${TH} text-right`}>Leftover</th>
              <th className={`${TH} text-right`}>Cost basis</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-wire">
            {(result.inputs || []).map(i => (
              <tr key={i.type_id}>
                <td className={`${TD} text-primary`}>{i.name}</td>
                <td className={`${TD} text-right font-mono text-secondary`}>{i.qty_consumed.toLocaleString()}</td>
                <td className={`${TD} text-right font-mono text-muted`}>{i.qty_leftover > 0 ? i.qty_leftover.toLocaleString() : '—'}</td>
                <td className={`${TD} text-right font-mono text-muted`}>{iska(i.line_cost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-wire">
            <tr>
              <td colSpan={3} className={`${TD} text-right text-muted`}>Input cost + fee</td>
              <td className={`${TD} text-right font-mono text-primary`}>{iska(result.total_cost_to_allocate)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="text-[11px] text-faint">
        Output cost basis is the consumed items' cost plus the station fee, split across minerals
        by each one's share of reference market value — not spread evenly per unit, so a rare
        mineral doesn't end up priced the same as a common one.
      </p>

      <div className="border border-wire rounded overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-hi border-b border-wire">
            <tr>
              <th className={`${TH} text-left`}>Producing</th>
              <th className={`${TH} text-right`}>Qty</th>
              <th className={`${TH} text-right`}>Value share</th>
              <th className={`${TH} text-right`}>New unit cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-wire">
            {(result.outputs || []).map(o => (
              <tr key={o.type_id}>
                <td className={`${TD} text-primary`}>{o.name}</td>
                <td className={`${TD} text-right font-mono text-eve-green`}>{o.qty.toLocaleString()}</td>
                <td className={`${TD} text-right font-mono text-muted`}>{o.value_share_pct.toFixed(1)}%</td>
                <td className={`${TD} text-right font-mono font-semibold text-primary`}>{iska(o.unit_cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end">
        <button onClick={handleConfirm} disabled={loading} className={BTN_SM_PRIMARY}>
          {loading ? 'Reprocessing…' : 'Confirm & Update Inventory'}
        </button>
      </div>
    </div>
  )

  // step === 'select'
  return (
    <div className="max-w-3xl space-y-4">
      {error && <p className="text-[12px] text-eve-red">{error}</p>}

      <div>
        <label className="block text-[11px] text-muted mb-1.5">Location</label>
        <select
          value={locationId}
          onChange={e => setLocationId(e.target.value ? Number(e.target.value) : '')}
          className="w-full max-w-xs bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
        >
          <option value="">Select location…</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      {locationId !== '' && !loadingCandidates && candidates.length > 0 && (
        <div>
          <label className="block text-[11px] text-muted mb-1.5">
            Paste to select — one per line, <span className="font-mono text-faint">Name  Qty</span> (matched
            against inventory at this location)
          </label>
          <textarea
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            rows={4}
            placeholder={'Compressed Veldspar II-Grade\t590200\nCompressed Gneiss IV-Grade\t127400'}
            className="w-full bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary placeholder:text-faint focus:outline-none focus:border-accent resize-none"
          />
          <div className="flex justify-end mt-1.5">
            <button onClick={handlePasteMatch} disabled={!pasteText.trim()} className={BTN_SM}>
              Match to inventory
            </button>
          </div>
          {pasteWarnings.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {pasteWarnings.map((w, i) => <p key={i} className="text-[11px] text-eve-amber">{w}</p>)}
            </div>
          )}
        </div>
      )}

      {locationId !== '' && (
        loadingCandidates ? (
          <p className="text-[12px] text-muted">Loading inventory…</p>
        ) : candidates.length === 0 ? (
          <div className="bg-surface border border-wire rounded p-8 text-center text-muted text-[13px]">
            No reprocessable items in inventory at this location.
          </div>
        ) : (
          <div className="border border-wire rounded overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="bg-surface-hi border-b border-wire">
                <tr>
                  <th className={`${TH} w-8`}></th>
                  <th className={`${TH} text-left`}>Item</th>
                  <th className={`${TH} text-right`}>Available</th>
                  <th className={`${TH} text-right`}>Qty to reprocess</th>
                  <th className={`${TH} text-right`}>Cost basis</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-wire">
                {candidates.map(c => (
                  <tr key={c.type_id}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={selected.has(c.type_id)} onChange={() => toggleSelect(c.type_id)} className="align-middle" />
                    </td>
                    <td className={`${TD} text-primary`}>{c.name}</td>
                    <td className={`${TD} text-right font-mono text-secondary`}>{c.qty_available.toLocaleString()}</td>
                    <td className={`${TD} text-right`}>
                      <input
                        type="number" min={0} max={c.qty_available} step={c.portion_size}
                        value={qtyByType[c.type_id] ?? 0}
                        onChange={e => setQty(c.type_id, Number(e.target.value), c.qty_available)}
                        disabled={!selected.has(c.type_id)}
                        className="w-28 bg-canvas border border-wire rounded px-2 py-1 text-[12px] text-right font-mono text-primary focus:outline-none focus:border-accent disabled:opacity-40"
                      />
                    </td>
                    <td className={`${TD} text-right font-mono text-muted`}>{iska(c.unit_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      <div className="flex gap-3">
        <div>
          <label className="block text-[11px] text-muted mb-1.5">Ore/ice efficiency</label>
          <div className="flex items-center gap-1.5">
            <input
              type="number" step="0.0001" min="0" max="100"
              value={efficiency}
              onChange={e => setEfficiency(Number(e.target.value))}
              className="w-28 bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
            />
            <span className="text-[13px] text-muted">%</span>
          </div>
        </div>
        <div>
          <label className="block text-[11px] text-muted mb-1.5">Gas efficiency</label>
          <div className="flex items-center gap-1.5">
            <input
              type="number" step="0.0001" min="0" max="100"
              value={gasEfficiency}
              onChange={e => setGasEfficiency(Number(e.target.value))}
              className="w-28 bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
            />
            <span className="text-[13px] text-muted">%</span>
          </div>
        </div>
        <div>
          <label className="block text-[11px] text-muted mb-1.5">Station fee</label>
          <div className="flex items-center gap-1.5">
            <input
              type="number" step="0.1" min="0" max="100"
              value={feePct}
              onChange={e => setFeePct(Number(e.target.value))}
              className="w-24 bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
            />
            <span className="text-[13px] text-muted">% of output value</span>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button onClick={handlePreview} disabled={selectedItems.length === 0 || loading} className={BTN_SM_PRIMARY}>
          {loading ? 'Calculating…' : 'Preview output'}
        </button>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

type Mode = 'buy' | 'reprocess'

export function ReprocessingClient() {
  const [mode, setMode] = useState<Mode>('buy')

  return (
    <div className="space-y-4">
      <div className="flex gap-1.5 border-b border-wire">
        {([
          { key: 'buy' as const, label: 'Buy Planner' },
          { key: 'reprocess' as const, label: 'Reprocess Inventory' },
        ]).map(t => (
          <button
            key={t.key}
            onClick={() => setMode(t.key)}
            className={`px-3 py-2 text-[12px] border-b-2 -mb-px transition-colors ${
              mode === t.key ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-secondary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {mode === 'buy' ? <BuyPlannerTab /> : <ReprocessInventoryTab />}
    </div>
  )
}
