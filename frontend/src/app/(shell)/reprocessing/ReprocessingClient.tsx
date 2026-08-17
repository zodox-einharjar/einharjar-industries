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
  unpriced: UnpricedItem[]
  unknown: UnknownItem[]
  parse_errors: string[]
  mineral_unresolved: string[]
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

// ── Main component ────────────────────────────────────────────────────────────

export function ReprocessingClient() {
  const [step, setStep] = useState<'form' | 'results'>('form')
  const [mineralsText, setMineralsText] = useState('')
  const [supplyText, setSupplyText] = useState('')
  const [priceType, setPriceType] = useState<'buy' | 'sell' | 'split'>('sell')
  const [efficiency, setEfficiency] = useState(90.63)
  const [result, setResult] = useState<OptimizeResponse | null>(null)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mineralsRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.reprocessing_efficiency_pct) setEfficiency(d.reprocessing_efficiency_pct) })
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
          <label className="block text-[11px] text-muted mb-1.5">Reprocessing efficiency</label>
          <div className="flex items-center gap-1.5">
            <input
              type="number" step="0.01" min="0" max="100"
              value={efficiency}
              onChange={e => setEfficiency(Number(e.target.value))}
              className="w-24 bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
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
          <span className="text-muted">{result.efficiency_pct.toFixed(2)}% efficiency</span>
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
