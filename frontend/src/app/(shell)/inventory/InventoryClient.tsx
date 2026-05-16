'use client'

import Link from 'next/link'
import { useState, useEffect, useMemo, useRef } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { useTopbarActions } from '@/lib/topbar-context'

// ── Types ─────────────────────────────────────────────────────────────────────

type ItemType = 'hull' | 'module' | 'ammo' | 'other'

interface InUseProject {
  id: number
  name: string
}

interface OnMarketListing {
  order_id: number
  qty: number
  list_price: number
}

interface ItemEntry {
  type_id: number
  name: string
  type: ItemType
  qty: number
  qty_reserved: number
  qty_on_market: number
  on_market_listings: OnMarketListing[]
  in_use_projects: InUseProject[]
  unit_volume: number
  total_volume: number
  unit_value: number
  jita_buy: number | null
  jita_sell: number | null
  total_value: number
}

interface LocationFees {
  broker_fee_pct: number
  sales_tax_pct: number
  scc_surcharge_pct: number
}

interface LocationGroup {
  location_id: number
  location_name: string
  system: string | null
  fees: LocationFees
  items: ItemEntry[]
}

interface LocationTab {
  id: number
  name: string
}

interface SelectedItem {
  type_id: number
  location_id: number
  name: string
  qty: number
  unit_volume: number
  unit_value: number
  jita_sell: number | null
  fees: LocationFees
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_DOT: Record<ItemType, string> = {
  hull:   'bg-accent',
  module: 'bg-purple-400',
  ammo:   'bg-eve-amber',
  other:  'bg-muted',
}

function iska(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}


// Round up to 4 significant figures — the maximum precision EVE allows for order prices.
function ceilTo4SigFigs(n: number): number {
  if (n <= 0) return n
  const tick = Math.pow(10, Math.floor(Math.log10(n)) - 3)
  return Math.ceil(n / tick) * tick
}

function fmtOrderPrice(n: number): string {
  return ceilTo4SigFigs(n).toLocaleString(undefined, { maximumFractionDigits: 4 })
}

function fmtVol(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}m m³`
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}k m³`
  return `${v.toLocaleString()} m³`
}

const GRID = '32px minmax(0,2fr) 72px 96px 96px minmax(118px,2fr) minmax(118px,2fr) minmax(118px,2fr) minmax(128px,2fr) 56px'
const CELL = 'flex items-center justify-end text-[12px] font-mono tabular-nums text-secondary'
const CELL_L = 'flex items-center gap-2 text-[12px] min-w-0'

const BTN_TAB_ACTIVE = 'flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded border border-accent text-accent bg-accent/10 transition-colors'
const BTN_TAB        = 'flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded border border-wire text-muted hover:text-secondary transition-colors'
const BTN_SM         = 'px-3 py-1 text-[12px] border border-wire text-muted hover:text-primary hover:border-secondary rounded transition-colors'
const BTN_SM_PRIMARY = 'px-3 py-1 text-[12px] border border-accent text-accent hover:bg-accent hover:text-canvas rounded transition-colors'
const BTN_PRIMARY    = 'px-4 py-1.5 text-[13px] border border-accent text-accent rounded hover:bg-accent hover:text-canvas transition-colors disabled:opacity-40 disabled:pointer-events-none'

const COL_HEADERS = ['Qty', 'Unit vol', 'Total vol', 'Unit val', 'Jita buy', 'Jita sell', 'Total val']

// ── Sub-components ────────────────────────────────────────────────────────────

function ColHeaders() {
  return (
    <div className="grid px-2 py-1 border-b border-wire bg-canvas sticky top-0 z-10"
         style={{ gridTemplateColumns: GRID }}>
      <div />
      <div className="text-[11px] text-faint pl-6">Item</div>
      {COL_HEADERS.map(h => (
        <div key={h} className="text-[11px] text-faint text-right pr-0.5">{h}</div>
      ))}
      <div />
    </div>
  )
}

function ItemRow({ item, locationId, selected, onToggle, onTransfer, onSell }: {
  item: ItemEntry
  locationId: number
  selected: boolean
  onToggle: () => void
  onTransfer: () => void
  onSell: () => void
}) {
  return (
    <div
      className={`grid px-2 group hover:bg-surface transition-colors border-b border-wire-dim last:border-b-0 ${selected ? 'bg-surface/50' : ''}`}
      style={{ gridTemplateColumns: GRID, height: '30px' }}
    >
      <div className="flex items-center justify-center">
        <input type="checkbox" checked={selected} onChange={onToggle}
               className="w-3 h-3 cursor-pointer accent-[var(--accent)]" />
      </div>
      <div className={`${CELL_L} pr-2`}>
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${TYPE_DOT[item.type]}`} />
        <span className="truncate text-primary">{item.name}</span>
        {item.qty_reserved > 0 && item.in_use_projects.map(p => (
          <Link key={p.id} href={`/industry/${p.id}`}
                className="flex-shrink-0 px-1.5 py-0.5 text-[10px] bg-accent/15 text-accent rounded hover:bg-accent/25 transition-colors whitespace-nowrap"
                title={`In use by: ${p.name}`}>
            {item.qty_reserved.toLocaleString()} in use
          </Link>
        ))}
        {item.qty_on_market > 0 && (
          <Link href="/market-orders"
                className="flex-shrink-0 px-1.5 py-0.5 text-[10px] bg-eve-amber/15 text-eve-amber rounded hover:bg-eve-amber/25 transition-colors whitespace-nowrap"
                title={item.on_market_listings.map(l => `${l.qty.toLocaleString()} @ ${iska(l.list_price)}`).join(', ')}>
            {item.qty_on_market.toLocaleString()} on market
          </Link>
        )}
      </div>
      <div className={CELL}>{item.qty > 0 ? item.qty.toLocaleString() : <span className="text-faint">0</span>}</div>
      <div className={CELL}>{fmtVol(item.unit_volume)}</div>
      <div className={CELL}>{fmtVol(item.total_volume)}</div>
      <div className={CELL}>{iska(item.unit_value)}</div>
      <div className={CELL}>{iska(item.jita_buy)}</div>
      <div className={CELL}>{iska(item.jita_sell)}</div>
      <div className={CELL}>{iska(item.total_value)}</div>
      <div className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={onTransfer} title="Transfer"
                className="px-1.5 py-0.5 text-[11px] text-muted hover:text-accent hover:bg-surface-hi rounded transition-colors">↗</button>
        <button onClick={onSell} title="Sell"
                className="px-1.5 py-0.5 text-[11px] text-muted hover:text-eve-red hover:bg-surface-hi rounded transition-colors">✕</button>
      </div>
    </div>
  )
}

function Modal({ title, onClose, wide, extraWide, children }: {
  title: string; onClose: () => void; wide?: boolean; extraWide?: boolean; children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className={`bg-surface border border-wire rounded-lg w-full max-h-[85vh] flex flex-col ${extraWide ? 'max-w-5xl' : wide ? 'max-w-3xl' : 'max-w-lg'}`}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-wire flex-shrink-0">
          <span className="text-[14px] font-semibold text-primary">{title}</span>
          <button onClick={onClose} className="text-muted hover:text-primary text-xl leading-none">×</button>
        </div>
        <div className="overflow-y-auto flex-1 px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

// ── Import modal ──────────────────────────────────────────────────────────────

interface PreviewRow {
  item_name: string
  qty: number
  unit_price: number
  date_str: string
  station_name: string
  ok: boolean
  status: 'ready' | 'unknown_item' | 'unknown_station'
}

interface PreviewResponse {
  rows: PreviewRow[]
  errors: string[]
  sell_count: number
}

const STATUS_LABEL: Record<PreviewRow['status'], string> = {
  ready:           'Ready',
  unknown_item:    'Unknown item',
  unknown_station: 'Unknown station',
}
const STATUS_COLOR: Record<PreviewRow['status'], string> = {
  ready:           'text-eve-green',
  unknown_item:    'text-eve-red',
  unknown_station: 'text-eve-amber',
}

interface JaniceItem {
  type_id: number | null
  item_name: string
  qty: number
  unit_price: number
  ok: boolean
}

function WalletImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [step, setStep] = useState<'paste' | 'preview' | 'done'>('paste')
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { textareaRef.current?.focus() }, [])

  async function handleParse() {
    if (!text.trim()) return
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/inventory/import-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error()
      setPreview(await res.json())
      setStep('preview')
    } catch {
      setError('Failed to parse. Check the format and try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirm() {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/inventory/import-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error()
      setResult(await res.json())
      setStep('done')
      onImported()
    } catch {
      setError('Failed to save.')
    } finally {
      setLoading(false)
    }
  }

  const readyCount = preview?.rows.filter(r => r.ok).length ?? 0

  if (step === 'done' && result) return (
    <div className="py-4 text-center space-y-2">
      <div className="text-[20px] text-eve-green font-mono">{result.created}</div>
      <div className="text-[13px] text-secondary">lot{result.created !== 1 ? 's' : ''} imported</div>
      {result.skipped > 0 && (
        <div className="text-[12px] text-muted">{result.skipped} rows skipped (unknown item or station)</div>
      )}
      <button onClick={onClose} className={`mt-4 ${BTN_SM_PRIMARY}`}>Done</button>
    </div>
  )

  return (
    <>
      {error && <p className="text-[12px] text-eve-red mb-3">{error}</p>}

      {step === 'paste' && (
        <>
          <p className="text-[12px] text-muted mb-3">
            Open the <strong className="text-secondary">Wallet</strong> window in EVE, select transactions, copy with Ctrl+A → Ctrl+C, and paste below.
          </p>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={e => setText(e.target.value)}
            rows={10}
            placeholder={"2026.04.27 17:49\t2\tGyrostabilizer II\t935,200 ISK\t-1,870,400 ISK\t…"}
            className="w-full bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary placeholder:text-faint focus:outline-none focus:border-accent resize-none mb-4"
          />
          <div className="flex justify-end">
            <button onClick={handleParse} disabled={!text.trim() || loading}
                    className={`${BTN_SM_PRIMARY} disabled:opacity-40 disabled:pointer-events-none`}>
              {loading ? 'Parsing…' : 'Preview'}
            </button>
          </div>
        </>
      )}

      {step === 'preview' && preview && (
        <>
          <div className="flex items-center gap-4 mb-3 text-[12px]">
            <span className="text-eve-green">{readyCount} ready to import</span>
            {preview.rows.length - readyCount > 0 && (
              <span className="text-muted">{preview.rows.length - readyCount} will be skipped</span>
            )}
            {preview.sell_count > 0 && (
              <span className="text-muted">{preview.sell_count} sell transaction{preview.sell_count !== 1 ? 's' : ''} ignored</span>
            )}
          </div>
          {preview.errors.length > 0 && (
            <div className="mb-3 space-y-0.5">
              {preview.errors.map((e, i) => <p key={i} className="text-[11px] text-eve-amber">{e}</p>)}
            </div>
          )}
          <div className="border border-wire rounded overflow-hidden mb-4">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-surface-hi border-b border-wire">
                  <th className="text-left px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Date</th>
                  <th className="text-left px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Item</th>
                  <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Qty</th>
                  <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Unit price</th>
                  <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i} className={`border-t border-wire ${!row.ok ? 'opacity-50' : ''}`}>
                    <td className="px-3 py-2 text-faint font-mono whitespace-nowrap">{row.date_str}</td>
                    <td className="px-3 py-2 text-primary max-w-[200px] truncate" title={row.item_name}>{row.item_name}</td>
                    <td className="px-3 py-2 text-right font-mono text-secondary">{row.qty.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono text-secondary">{iska(row.unit_price)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${STATUS_COLOR[row.status]}`}>
                      {STATUS_LABEL[row.status]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between">
            <button onClick={() => setStep('paste')} className={BTN_SM}>← Back</button>
            <button onClick={handleConfirm} disabled={readyCount === 0 || loading}
                    className={`${BTN_SM_PRIMARY} disabled:opacity-40 disabled:pointer-events-none`}>
              {loading ? 'Importing…' : `Import ${readyCount} lot${readyCount !== 1 ? 's' : ''}`}
            </button>
          </div>
        </>
      )}
    </>
  )
}

const PRICE_TYPES = [
  { value: 'buy'  as const, label: 'Jita buy'  },
  { value: 'sell' as const, label: 'Jita sell' },
  { value: 'split'as const, label: 'Split'     },
]

function JaniceImport({ locations, onClose, onImported }: {
  locations: LocationTab[]
  onClose: () => void
  onImported: () => void
}) {
  const [step, setStep] = useState<'form' | 'preview' | 'done'>('form')
  const [text, setText] = useState('')
  const [locationId, setLocationId] = useState<number | ''>('')
  const [priceType, setPriceType] = useState<'buy' | 'sell' | 'split'>('sell')
  const [items, setItems] = useState<JaniceItem[]>([])
  const [parseErrors, setParseErrors] = useState<string[]>([])
  const [created, setCreated] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handlePreview() {
    if (!text.trim() || !locationId) return
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/inventory/import-janice-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), price_type: priceType, location_id: locationId }),
      })
      if (!res.ok) throw new Error((await res.json()).detail || 'Parse failed')
      const data = await res.json()
      setItems(data.items)
      setParseErrors(data.errors)
      setStep('preview')
    } catch (e: any) {
      setError(e.message || 'Failed to parse')
    } finally {
      setLoading(false)
    }
  }

  async function handleImport() {
    const ready = items.filter(i => i.ok)
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/inventory/import-janice-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: ready, location_id: locationId }),
      })
      if (!res.ok) throw new Error()
      setCreated((await res.json()).created)
      setStep('done')
      onImported()
    } catch {
      setError('Failed to save.')
    } finally {
      setLoading(false)
    }
  }

  if (step === 'done') return (
    <div className="py-4 text-center space-y-2">
      <div className="text-[20px] text-eve-green font-mono">{created}</div>
      <div className="text-[13px] text-secondary">lot{created !== 1 ? 's' : ''} imported</div>
      <button onClick={onClose} className={`mt-4 ${BTN_SM_PRIMARY}`}>Done</button>
    </div>
  )

  const readyCount = items.filter(i => i.ok).length

  return (
    <>
      {error && <p className="text-[12px] text-eve-red mb-3">{error}</p>}

      {step === 'form' && (
        <>
          <p className="text-[12px] text-muted mb-4">
            In Janice, select all rows and copy. Paste the result below.<br />
            Expected columns: <span className="text-faint font-mono">Name · Qty · Volume · Buy price · Sell price</span>
          </p>
          <div className="space-y-4 mb-5">
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              rows={7}
              placeholder={"Nitrogen Fuel Block\t10\t5.00\t17010.00\t17960.00"}
              className="w-full bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary placeholder:text-faint focus:outline-none focus:border-accent resize-none"
            />
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-[11px] text-muted mb-1.5">Location</label>
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
                <label className="block text-[11px] text-muted mb-1.5">Price (cost basis)</label>
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
          </div>
          <div className="flex justify-end">
            <button onClick={handlePreview} disabled={!text.trim() || !locationId || loading}
                    className={`${BTN_SM_PRIMARY} disabled:opacity-40 disabled:pointer-events-none`}>
              {loading ? 'Parsing…' : 'Preview'}
            </button>
          </div>
        </>
      )}

      {step === 'preview' && (
        <>
          <div className="flex items-center gap-4 mb-3 text-[12px]">
            <span className="text-eve-green">{readyCount} ready to import</span>
            {items.length - readyCount > 0 && (
              <span className="text-muted">{items.length - readyCount} unknown item{items.length - readyCount !== 1 ? 's' : ''} will be skipped</span>
            )}
          </div>
          {parseErrors.length > 0 && (
            <div className="mb-3 space-y-0.5">
              {parseErrors.map((e, i) => <p key={i} className="text-[11px] text-eve-amber">{e}</p>)}
            </div>
          )}
          <div className="border border-wire rounded overflow-hidden mb-4 max-h-72 overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0">
                <tr className="bg-surface-hi border-b border-wire">
                  <th className="text-left px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Item</th>
                  <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Qty</th>
                  <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Unit cost</th>
                  <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr key={i} className={`border-t border-wire ${!item.ok ? 'opacity-50' : ''}`}>
                    <td className="px-3 py-2 text-primary max-w-[200px] truncate" title={item.item_name}>{item.item_name}</td>
                    <td className="px-3 py-2 text-right font-mono text-secondary">{item.qty.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono text-secondary">{iska(item.unit_price)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${item.ok ? 'text-eve-green' : 'text-eve-red'}`}>
                      {item.ok ? 'Ready' : 'Unknown item'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between">
            <button onClick={() => setStep('form')} className={BTN_SM}>← Back</button>
            <button onClick={handleImport} disabled={readyCount === 0 || loading}
                    className={`${BTN_SM_PRIMARY} disabled:opacity-40 disabled:pointer-events-none`}>
              {loading ? 'Importing…' : `Import ${readyCount} lot${readyCount !== 1 ? 's' : ''}`}
            </button>
          </div>
        </>
      )}
    </>
  )
}

function ImportModal({ locations, onClose, onImported }: {
  locations: LocationTab[]
  onClose: () => void
  onImported: () => void
}) {
  const [tab, setTab] = useState<'wallet' | 'janice'>('wallet')

  return (
    <Modal title="Import inventory" onClose={onClose} wide>
      <div className="flex gap-2 mb-5 border-b border-wire pb-3">
        <button onClick={() => setTab('wallet')} className={tab === 'wallet' ? BTN_TAB_ACTIVE : BTN_TAB}>
          Wallet transactions
        </button>
        <button onClick={() => setTab('janice')} className={tab === 'janice' ? BTN_TAB_ACTIVE : BTN_TAB}>
          Janice appraisal
        </button>
      </div>
      {tab === 'wallet'
        ? <WalletImport onClose={onClose} onImported={onImported} />
        : <JaniceImport locations={locations} onClose={onClose} onImported={onImported} />
      }
    </Modal>
  )
}

function SellModal({ items, onClose, onSold }: {
  items: SelectedItem[]
  onClose: () => void
  onSold: () => void
}) {
  const [method, setMethod] = useState<'market' | 'contract'>('market')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [highlightedCell, setHighlightedCell] = useState<string | null>(null)
  const [sellPrices, setSellPrices] = useState<Map<string, string>>(() => {
    const m = new Map<string, string>()
    items.forEach(i => {
      m.set(`${i.type_id}:${i.location_id}`, i.jita_sell != null ? String(i.jita_sell) : '')
    })
    return m
  })
  const [sellQtys, setSellQtys] = useState<Map<string, string>>(() => {
    const m = new Map<string, string>()
    items.forEach(i => m.set(`${i.type_id}:${i.location_id}`, String(i.qty)))
    return m
  })

  const totalQty = items.reduce((s, i) => {
    const k = `${i.type_id}:${i.location_id}`
    return s + (parseInt(sellQtys.get(k) ?? '') || 0)
  }, 0)

  const feeFrac = method === 'contract'
    ? 0
    : ((items[0]?.fees.broker_fee_pct ?? 0) + (items[0]?.fees.sales_tax_pct ?? 0) + (items[0]?.fees.scc_surcharge_pct ?? 0)) / 100

  function fillPrice(k: string, refKey: string, val: number) {
    setSellPrices(prev => new Map(prev).set(k, String(val)))
    setHighlightedCell(refKey)
    setTimeout(() => setHighlightedCell(null), 1200)
  }

  async function handleSell() {
    setLoading(true)
    try {
      const res = await fetch('/api/inventory/mark-sold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: items.map(i => {
            const k = `${i.type_id}:${i.location_id}`
            const price = parseFloat((sellPrices.get(k) ?? '').replace(/[\s,]/g, '')) || 0
            const qty = Math.min(parseInt(sellQtys.get(k) ?? '') || 0, i.qty)
            return { type_id: i.type_id, qty, location_id: i.location_id, unit_sell_price: price, method }
          }),
        }),
      })
      if (!res.ok) throw new Error()
      setDone(true)
      onSold()
    } finally {
      setLoading(false)
    }
  }

  if (done) return (
    <Modal title="Record manual sale" onClose={onClose} extraWide>
      <div className="py-6 text-center space-y-2">
        <div className="text-[20px] text-eve-green font-mono">{totalQty.toLocaleString()}</div>
        <div className="text-[13px] text-secondary">units removed from inventory</div>
        <button onClick={onClose} className={`mt-4 ${BTN_SM_PRIMARY}`}>Done</button>
      </div>
    </Modal>
  )

  return (
    <Modal title="Record manual sale" onClose={onClose} extraWide>
      {/* Method toggle */}
      <div className="flex gap-2 mb-5 pb-4 border-b border-wire">
        <button onClick={() => setMethod('market')} className={method === 'market' ? BTN_TAB_ACTIVE : BTN_TAB}>
          Market order
        </button>
        <button onClick={() => setMethod('contract')} className={method === 'contract' ? BTN_TAB_ACTIVE : BTN_TAB}>
          Contract
        </button>
      </div>

      <div className="border border-wire rounded overflow-hidden mb-3">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="bg-surface-hi border-b border-wire">
              <th className="text-left px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Item</th>
              <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Qty</th>
              <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Cost/u</th>
              {method === 'market' && <>
                <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Break-even</th>
                <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">+5%</th>
                <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">+10%</th>
                <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Jita sell</th>
              </>}
              <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">
                {method === 'market' ? 'Listing price' : 'Contract price'}
              </th>
              <th className="text-right px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Est. profit</th>
            </tr>
          </thead>
          <tbody>
            {items.map(i => {
              const k = `${i.type_id}:${i.location_id}`
              const rawPrice = sellPrices.get(k) ?? ''
              const rawQty = sellQtys.get(k) ?? ''
              const price = parseFloat(rawPrice.replace(/[\s,]/g, '')) || 0
              const qty = Math.min(parseInt(rawQty) || 0, i.qty)
              const netPerUnit = method === 'contract'
                ? price - i.unit_value
                : price * (1 - feeFrac) - i.unit_value
              const totalProfit = price > 0 && qty > 0 ? netPerUnit * qty : null

              const be  = method === 'market' && feeFrac < 1 ? ceilTo4SigFigs(i.unit_value / (1 - feeFrac)) : null
              const m5  = be != null ? ceilTo4SigFigs(be * 1.05)  : null
              const m10 = be != null ? ceilTo4SigFigs(be * 1.10) : null

              return (
                <tr key={k} className="border-t border-wire">
                  <td className="px-3 py-2 text-primary max-w-[160px] truncate" title={i.name}>{i.name}</td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={rawQty}
                      onChange={e => setSellQtys(prev => new Map(prev).set(k, e.target.value))}
                      className={`bg-canvas border rounded px-2 py-0.5 text-[12px] font-mono text-right text-primary focus:outline-none focus:border-accent w-24 ${
                        parseInt(rawQty) > i.qty ? 'border-eve-red' : 'border-wire'
                      }`}
                    />
                    {parseInt(rawQty) > i.qty && (
                      <div className="text-[10px] text-eve-red text-right">max {i.qty.toLocaleString()}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-secondary">{iska(i.unit_value)}</td>
                  {method === 'market' && <>
                    {([
                      { refKey: `${k}:be`,  val: be,  cls: 'text-eve-amber' },
                      { refKey: `${k}:m5`,  val: m5,  cls: 'text-eve-green' },
                      { refKey: `${k}:m10`, val: m10, cls: 'text-eve-green' },
                    ] as const).map(({ refKey, val, cls }) => (
                      <td
                        key={refKey}
                        onClick={() => val != null && fillPrice(k, refKey, val)}
                        title={val != null ? 'Click to use as listing price' : undefined}
                        className={`px-3 py-2 text-right font-mono select-none transition-colors ${
                          val != null ? 'cursor-pointer' : ''
                        } ${highlightedCell === refKey ? 'bg-eve-green/10 text-eve-green' : cls}`}
                      >
                        {val != null ? (highlightedCell === refKey ? '✓' : fmtOrderPrice(val)) : '—'}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right font-mono text-muted">{iska(i.jita_sell)}</td>
                  </>}
                  <td className="px-3 py-2 text-right">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={rawPrice}
                      onChange={e => setSellPrices(prev => new Map(prev).set(k, e.target.value))}
                      placeholder="0.00"
                      className="bg-canvas border border-wire rounded px-2 py-0.5 text-[12px] font-mono text-right text-primary focus:outline-none focus:border-accent w-36"
                    />
                  </td>
                  <td className={`px-3 py-2 text-right font-mono tabular-nums ${
                    totalProfit == null ? 'text-faint' :
                    totalProfit >= 0 ? 'text-eve-green' : 'text-eve-red'
                  }`}>
                    {totalProfit != null ? iska(totalProfit) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {method === 'market' && items.length > 0 && (
        <p className="text-[11px] text-faint mb-4">
          Fees: {items[0].fees.broker_fee_pct}% broker + {items[0].fees.sales_tax_pct}% sales tax
          {items[0].fees.scc_surcharge_pct > 0 ? ` + ${items[0].fees.scc_surcharge_pct}% SCC` : ''}
          · Click a reference price to auto-fill the listing price field · Change fees in Settings → Locations
        </p>
      )}
      {method === 'contract' && (
        <p className="text-[11px] text-faint mb-4">No broker fees or sales tax on contracts.</p>
      )}

      <button onClick={handleSell} disabled={loading} className={`${BTN_SM_PRIMARY} disabled:opacity-40 disabled:pointer-events-none`}>
        {loading ? 'Saving…' : 'Record manual sale'}
      </button>
    </Modal>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function InventoryClient() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const { setActions } = useTopbarActions()

  const [data, setData] = useState<LocationGroup[]>([])
  const [locations, setLocations] = useState<LocationTab[]>([])
  const [freightRoutes, setFreightRoutes] = useState<{from_id: number, to_id: number, isk_per_m3: number, value_pct: number}[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<number>>(() => {
    if (typeof window === 'undefined') return new Set()
    try {
      const s = localStorage.getItem('inv_collapsed')
      return s ? new Set(JSON.parse(s)) : new Set()
    } catch { return new Set() }
  })
  const [selected, setSelected] = useState<Map<string, SelectedItem>>(new Map())
  const [importOpen, setImportOpen] = useState(false)

  // Transfer modal
  const [transferOpen, setTransferOpen]   = useState(false)
  const [transferItems, setTransferItems] = useState<SelectedItem[]>([])
  const [destLocId, setDestLocId]         = useState<number | ''>('')
  const [transferError, setTransferError] = useState<string | null>(null)
  const [transferBusy, setTransferBusy]   = useState(false)

  // Sell modal
  const [sellOpen, setSellOpen]   = useState(false)
  const [sellItems, setSellItems] = useState<SelectedItem[]>([])

  const activeLocation = searchParams.get('location') ? Number(searchParams.get('location')) : null

  function setParam(key: string, value: string | null) {
    const p = new URLSearchParams(searchParams)
    value == null ? p.delete(key) : p.set(key, value)
    router.replace(`${pathname}?${p}`)
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    setActions(
      <button onClick={() => setImportOpen(true)} className={BTN_SM_PRIMARY}>+ Import</button>
    )
    return () => setActions(null)
  }, [setActions])

  async function load() {
    setLoading(true); setError(null)
    try {
      const [rl, ri, rr] = await Promise.all([fetch('/api/locations'), fetch('/api/inventory'), fetch('/api/freight-routes')])
      if (!rl.ok || !ri.ok) throw new Error()
      const [locs, inv] = await Promise.all([rl.json(), ri.json()])
      const routes = rr.ok ? await rr.json() : []
      setLocations(locs)
      setData(inv)
      setFreightRoutes(routes)
    } catch {
      setError('Failed to load inventory.')
    } finally {
      setLoading(false)
    }
  }

  function toggleCollapsed(id: number) {
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      if (typeof window !== 'undefined')
        localStorage.setItem('inv_collapsed', JSON.stringify([...next]))
      return next
    })
  }

  const selKey = (typeId: number, locId: number) => `${typeId}:${locId}`

  function toggleItem(item: ItemEntry, locationId: number, fees: LocationFees) {
    const k = selKey(item.type_id, locationId)
    setSelected(prev => {
      const next = new Map(prev)
      if (next.has(k)) next.delete(k)
      else next.set(k, { type_id: item.type_id, location_id: locationId, name: item.name, qty: item.qty, unit_volume: item.unit_volume, unit_value: item.unit_value, jita_sell: item.jita_sell, fees })
      return next
    })
  }

  function toggleSection(group: LocationGroup) {
    const keys = group.items.map(i => selKey(i.type_id, group.location_id))
    const allSel = keys.every(k => selected.has(k))
    setSelected(prev => {
      const next = new Map(prev)
      if (allSel) {
        keys.forEach(k => next.delete(k))
      } else {
        group.items.forEach(i =>
          next.set(selKey(i.type_id, group.location_id), {
            type_id: i.type_id, location_id: group.location_id,
            name: i.name, qty: i.qty, unit_volume: i.unit_volume, unit_value: i.unit_value, jita_sell: i.jita_sell, fees: group.fees,
          })
        )
      }
      return next
    })
  }

  function openTransfer(items: SelectedItem[]) {
    setTransferItems(items); setTransferError(null)
    setDestLocId(''); setTransferOpen(true)
  }

  function openSell(items: SelectedItem[]) {
    setSellItems(items); setSellOpen(true)
  }

  async function confirmTransfer() {
    if (!destLocId) return
    setTransferBusy(true); setTransferError(null)
    try {
      const res = await fetch('/api/inventory/transfer-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: transferItems.map(i => ({ type_id: i.type_id, qty: i.qty, from_location_id: i.location_id })),
          to_location_id: Number(destLocId),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setTransferError(err.detail ?? 'Transfer failed.')
        return
      }
      setTransferOpen(false)
      setSelected(new Map())
      load()
    } catch {
      setTransferError('Network error.')
    } finally {
      setTransferBusy(false)
    }
  }


  const filteredData = useMemo(() => {
    const q = search.trim().toLowerCase()
    return data
      .filter(g => activeLocation === null || g.location_id === activeLocation)
      .map(g => ({ ...g, items: q ? g.items.filter(i => i.name.toLowerCase().includes(q)) : g.items }))
      .filter(g => g.items.length > 0)
  }, [data, activeLocation, search])

  const selectionArray = [...selected.values()]

  if (loading) return <p className="text-muted text-[13px]">Loading…</p>
  if (error)   return <p className="text-eve-red text-[13px]">{error}</p>

  return (
    <>
      {/* Location tabs + search */}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <div className="flex gap-1.5 flex-wrap flex-1 min-w-0">
          <button onClick={() => setParam('location', null)} className={activeLocation === null ? BTN_TAB_ACTIVE : BTN_TAB}>All</button>
          {locations.map(loc => (
            <button key={loc.id} onClick={() => setParam('location', String(loc.id))}
                    className={activeLocation === loc.id ? BTN_TAB_ACTIVE : BTN_TAB}>
              {loc.name}
            </button>
          ))}
        </div>
        <input
          type="search" placeholder="Search items…" value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-surface border border-wire rounded px-3 py-1.5 text-[12px] text-primary placeholder:text-faint focus:outline-none focus:border-accent w-52 flex-shrink-0"
        />
      </div>

      {/* Bulk action bar */}
      {selectionArray.length > 0 && (
        <div className="flex items-center gap-3 mb-4 px-4 py-2 bg-surface border border-wire rounded">
          <span className="text-[12px] text-secondary">
            {selectionArray.length} item{selectionArray.length !== 1 ? 's' : ''} selected
          </span>
          <button onClick={() => openTransfer(selectionArray)} className={BTN_SM_PRIMARY}>Transfer</button>
          <button onClick={() => openSell(selectionArray)} className={BTN_SM}>Sell</button>
          <button onClick={() => setSelected(new Map())} className={BTN_SM}>Clear</button>
        </div>
      )}

      {/* Location sections */}
      {filteredData.length === 0 ? (
        <div className="rounded border border-wire px-4 py-12 text-center text-[13px]">
          {data.length === 0 ? (
            <span>
              No inventory yet.{' '}
              <button onClick={() => setImportOpen(true)} className="text-accent hover:underline">
                Import from wallet journal
              </button>{' '}
              to get started.
            </span>
          ) : (
            <span className="text-muted">No items match the current filter.</span>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredData.map(group => {
            const isCollapsed = collapsed.has(group.location_id)
            const keys = group.items.map(i => selKey(i.type_id, group.location_id))
            const allSel = keys.length > 0 && keys.every(k => selected.has(k))
            const someSel = !allSel && keys.some(k => selected.has(k))

            return (
              <div key={group.location_id} className="border border-wire rounded overflow-hidden">
                {/* Header */}
                <div
                  className="flex items-center gap-3 px-3 py-2.5 bg-surface border-b border-wire cursor-pointer select-none"
                  onClick={() => toggleCollapsed(group.location_id)}
                >
                  <div onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={allSel}
                      ref={el => { if (el) el.indeterminate = someSel }}
                      onChange={() => toggleSection(group)}
                      className="w-3 h-3 cursor-pointer accent-[var(--accent)]"
                    />
                  </div>
                  <span className="text-[13px] font-semibold text-primary">{group.location_name}</span>
                  {group.system && (
                    <span className="text-[11px] text-muted">· {group.system}</span>
                  )}
                  <span className="text-[11px] text-faint ml-auto mr-2">
                    {group.items.length} item{group.items.length !== 1 ? 's' : ''}
                  </span>
                  <span className="text-muted text-[11px]">{isCollapsed ? '▸' : '▾'}</span>
                </div>

                {/* Table */}
                {!isCollapsed && (
                  <div className="overflow-x-auto">
                    <ColHeaders />
                    {group.items.map(item => (
                      <ItemRow
                        key={item.type_id}
                        item={item}
                        locationId={group.location_id}
                        selected={selected.has(selKey(item.type_id, group.location_id))}
                        onToggle={() => toggleItem(item, group.location_id, group.fees)}
                        onTransfer={() => openTransfer([{
                          type_id: item.type_id, location_id: group.location_id,
                          name: item.name, qty: item.qty, unit_volume: item.unit_volume, unit_value: item.unit_value, jita_sell: item.jita_sell, fees: group.fees,
                        }])}
                        onSell={() => openSell([{
                          type_id: item.type_id, location_id: group.location_id,
                          name: item.name, qty: item.qty, unit_volume: item.unit_volume, unit_value: item.unit_value, jita_sell: item.jita_sell, fees: group.fees,
                        }])}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Transfer modal */}
      {transferOpen && (() => {
        const totalM3    = transferItems.reduce((s, i) => s + i.qty * i.unit_volume, 0)
        const totalValue = transferItems.reduce((s, i) => s + i.qty * i.unit_value, 0)
        const totalFreight = destLocId !== '' ? transferItems.reduce((s, i) => {
          const route = freightRoutes.find(r => r.from_id === i.location_id && r.to_id === destLocId)
          if (!route) return s
          return s + i.qty * i.unit_volume * route.isk_per_m3 + i.qty * (i.jita_sell ?? 0) * (route.value_pct / 100)
        }, 0) : null

        const fromIds = [...new Set(transferItems.map(i => i.location_id))]
        const missingRoutes = destLocId !== ''
          ? fromIds.filter(fid => fid !== destLocId && !freightRoutes.some(r => r.from_id === fid && r.to_id === destLocId))
          : []
        const missingNames = missingRoutes.map(fid => locations.find(l => l.id === fid)?.name ?? `#${fid}`)

        return (
          <Modal title="Transfer" onClose={() => setTransferOpen(false)}>
            <div className="space-y-0.5 mb-4 max-h-40 overflow-y-auto">
              {transferItems.map(i => (
                <div key={`${i.type_id}:${i.location_id}`} className="text-[12px] text-secondary">
                  {i.qty.toLocaleString()}× <span className="text-primary">{i.name}</span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <div className="bg-canvas border border-wire rounded px-3 py-2">
                <div className="text-[10px] text-muted mb-0.5">Volume</div>
                <div className="text-[13px] text-primary font-mono">{fmtVol(totalM3)}</div>
              </div>
              <div className="bg-canvas border border-wire rounded px-3 py-2">
                <div className="text-[10px] text-muted mb-0.5">Value</div>
                <div className="text-[13px] text-primary font-mono">{iska(totalValue)}</div>
              </div>
              <div className="bg-canvas border border-wire rounded px-3 py-2">
                <div className="text-[10px] text-muted mb-0.5">Freight</div>
                <div className="text-[13px] font-mono text-primary">
                  {totalFreight === null ? <span className="text-muted">—</span> : iska(totalFreight)}
                </div>
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-[11px] text-muted mb-1.5">Destination</label>
              <select
                value={destLocId}
                onChange={e => setDestLocId(e.target.value ? Number(e.target.value) : '')}
                className="w-full bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
              >
                <option value="">Select location…</option>
                {locations.map(l => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
            {missingNames.length > 0 && (
              <p className="text-amber-400 text-[12px] mb-3">
                No freight route from {missingNames.join(', ')} — those items transfer at cost basis with no freight charge.
              </p>
            )}
            {transferError && (
              <p className="text-eve-red text-[12px] mb-3">{transferError}</p>
            )}
            <button onClick={confirmTransfer} disabled={!destLocId || transferBusy} className={BTN_PRIMARY}>
              {transferBusy ? 'Transferring…' : 'Transfer'}
            </button>
          </Modal>
        )
      })()}

      {/* Sell modal */}
      {sellOpen && (
        <SellModal
          items={sellItems}
          onClose={() => setSellOpen(false)}
          onSold={() => { setSelected(new Map()); setSellOpen(false); load() }}
        />
      )}

      {/* Import modal */}
      {importOpen && (
        <ImportModal
          locations={locations}
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); load() }}
        />
      )}
    </>
  )
}
