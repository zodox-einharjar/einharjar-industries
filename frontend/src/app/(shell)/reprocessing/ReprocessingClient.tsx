'use client'

import { useEffect, useRef, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface OreLine {
  type_id: number
  name: string
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

interface UnpricedOre {
  type_id: number
  name: string
  qty: number
}

interface UnknownOre {
  item_name: string
  qty: number
}

interface OptimizeResponse {
  ore_to_buy: OreLine[]
  total_cost: number
  minerals: MineralLine[]
  unmet_minerals: UnmetMineral[]
  efficiency_pct: number
  ore_unpriced: UnpricedOre[]
  ore_unknown: UnknownOre[]
  ore_parse_errors: string[]
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

const PRICE_TYPES = [
  { value: 'buy'   as const, label: 'Buy price'  },
  { value: 'sell'  as const, label: 'Sell price' },
  { value: 'split' as const, label: 'Split'      },
]

const TD = 'px-3 py-2 align-middle'
const TH = 'px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider whitespace-nowrap'
const BTN_SM = 'px-3 py-1 text-[12px] border border-wire text-muted hover:text-primary hover:border-secondary rounded transition-colors'
const BTN_SM_PRIMARY = 'px-3 py-1 text-[12px] border border-accent text-accent hover:bg-accent hover:text-canvas rounded transition-colors disabled:opacity-40 disabled:pointer-events-none'

// ── Main component ────────────────────────────────────────────────────────────

export function ReprocessingClient() {
  const [step, setStep] = useState<'form' | 'results'>('form')
  const [mineralsText, setMineralsText] = useState('')
  const [oreText, setOreText] = useState('')
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
    mineralsRef.current?.focus()
  }, [])

  async function handleOptimize() {
    if (!mineralsText.trim() || !oreText.trim()) return
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/reprocessing/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          minerals_text: mineralsText.trim(),
          ore_text: oreText.trim(),
          price_type: priceType,
          efficiency_pct: efficiency,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).detail || 'Optimization failed')
      setResult(await res.json())
      setStep('results')
    } catch (e: any) {
      setError(e.message || 'Failed to optimize')
    } finally {
      setLoading(false)
    }
  }

  async function copyList() {
    if (!result || result.ore_to_buy.length === 0) return
    await copyText(buildMultibuy(result.ore_to_buy.map(o => ({ name: o.name, qty: o.qty }))))
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
          Available ore — Janice paste (select all rows, copy)<br />
          Expected columns: <span className="text-faint font-mono">Name · Qty · Volume · Buy price · Sell price</span>
        </label>
        <textarea
          value={oreText}
          onChange={e => setOreText(e.target.value)}
          rows={10}
          placeholder={"Compressed Veldspar\t1000000\t0.00\t1.50\t1.80"}
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
        <button onClick={handleOptimize} disabled={!mineralsText.trim() || !oreText.trim() || loading} className={BTN_SM_PRIMARY}>
          {loading ? 'Solving…' : 'Find cheapest combination'}
        </button>
      </div>
    </div>
  )

  // step === 'results'
  if (!result) return null

  const hasErrors = result.ore_parse_errors.length > 0 || result.ore_unknown.length > 0 ||
    result.ore_unpriced.length > 0 || result.mineral_unresolved.length > 0

  return (
    <div className="space-y-4">
      {error && <p className="text-[12px] text-eve-red">{error}</p>}
      <div className="flex items-center justify-between">
        <div className="text-[13px] text-primary">
          {result.ore_to_buy.length} ore type{result.ore_to_buy.length !== 1 ? 's' : ''} ·{' '}
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
              <strong>{m.name}</strong>: short by {m.shortfall.toLocaleString()} — the pasted ore
              can't produce more than {m.qty_produced.toLocaleString()} of the {m.qty_needed.toLocaleString()} needed.
            </div>
          ))}
        </div>
      )}

      <div className="border border-wire rounded overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-hi border-b border-wire">
            <tr>
              <th className={`${TH} text-left`}>Ore to buy</th>
              <th className={`${TH} text-right`}>Qty</th>
              <th className={`${TH} text-right`}>Unit price</th>
              <th className={`${TH} text-right`}>Line cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-wire">
            {result.ore_to_buy.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted">Nothing to buy</td></tr>
            ) : result.ore_to_buy.map(o => (
              <tr key={o.type_id}>
                <td className={`${TD} text-primary`}>{o.name}</td>
                <td className={`${TD} text-right font-mono text-secondary`}>{o.qty.toLocaleString()}</td>
                <td className={`${TD} text-right font-mono text-muted`}>{iska(o.unit_price)}</td>
                <td className={`${TD} text-right font-mono font-semibold text-primary`}>{iska(o.line_cost)}</td>
              </tr>
            ))}
          </tbody>
          {result.ore_to_buy.length > 0 && (
            <tfoot className="border-t border-wire">
              <tr>
                <td colSpan={3} className={`${TD} text-right text-muted`}>Total</td>
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
          {result.ore_unknown.length > 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-eve-red hover:text-secondary">{result.ore_unknown.length} unknown ore item{result.ore_unknown.length !== 1 ? 's' : ''}</summary>
              <div className="mt-2 space-y-0.5 pl-3">
                {result.ore_unknown.map((item, i) => (
                  <div key={i} className="flex items-center gap-3 text-faint">
                    <span className="flex-1 truncate">{item.item_name}</span>
                    <span className="font-mono">×{item.qty.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {result.ore_unpriced.length > 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-muted hover:text-secondary">{result.ore_unpriced.length} ore with no price</summary>
              <div className="mt-2 space-y-0.5 pl-3">
                {result.ore_unpriced.map((item, i) => (
                  <div key={i} className="flex items-center gap-3 text-faint">
                    <span className="flex-1 truncate">{item.name}</span>
                    <span className="font-mono">×{item.qty.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {result.ore_parse_errors.length > 0 && (
            <div className="space-y-0.5">
              {result.ore_parse_errors.map((e, i) => <p key={i} className="text-[11px] text-eve-amber">{e}</p>)}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={copyList} disabled={result.ore_to_buy.length === 0} className={BTN_SM}>
          {copied ? '✓ Copied' : 'Copy to Multibuy'}
        </button>
      </div>
    </div>
  )
}
