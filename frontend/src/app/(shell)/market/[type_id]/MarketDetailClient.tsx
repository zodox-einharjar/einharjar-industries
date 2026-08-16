'use client'

import { useState } from 'react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface HistoryPoint { date: string; average: number; highest: number; lowest: number }
interface VelocityPoint { date: string; volume: number; order_count: number }
interface DepthPoint { price: number; cumulative: number }

interface Location { id: number; name: string }

interface ItemDetail {
  type_id: number
  name: string
  tracked: boolean
  location: Location | null
  history: HistoryPoint[]
  velocity: VelocityPoint[]
  depth: { buy: DepthPoint[]; sell: DepthPoint[] }
  data_as_of: string | null
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

function fmtDateShort(dateStr: string): string {
  const [, m, d] = dateStr.split('-')
  return `${parseInt(m)}/${parseInt(d)}`
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

const SECTION = 'text-[11px] font-semibold tracking-[0.1em] text-faint uppercase mb-4'
const CARD = 'bg-surface border border-wire rounded p-4'
const INPUT = 'bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent transition-colors'
const BTN_SM_PRIMARY = 'px-3 py-1 text-[12px] border border-accent text-accent hover:bg-accent hover:text-canvas rounded transition-colors disabled:opacity-40 disabled:pointer-events-none'
const EMPTY = 'text-center text-muted text-[13px] py-16'

// ── Tooltips ──────────────────────────────────────────────────────────────────

function HistoryTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const p = payload[0]?.payload as HistoryPoint
  return (
    <div className="bg-surface border border-wire rounded px-3 py-2 text-[12px] shadow-lg">
      <div className="text-muted mb-1">{label}</div>
      <div className="text-accent">Avg: {iska(p.average)}</div>
      <div className="text-eve-green">High: {iska(p.highest)}</div>
      <div className="text-eve-red">Low: {iska(p.lowest)}</div>
    </div>
  )
}

function VelocityTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const p = payload[0]?.payload as VelocityPoint
  return (
    <div className="bg-surface border border-wire rounded px-3 py-2 text-[12px] shadow-lg">
      <div className="text-muted mb-1">{label}</div>
      <div className="text-eve-green">Volume: {iska(p.volume)}</div>
      <div className="text-accent">Orders: {p.order_count.toLocaleString()}</div>
    </div>
  )
}

function DepthTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface border border-wire rounded px-3 py-2 text-[12px] shadow-lg">
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.stroke }}>
          {p.name}: {iska(p.payload.price)} → {p.value.toLocaleString()} units
        </div>
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function MarketDetailClient({ initialItem, locations }: { initialItem: ItemDetail; locations: Location[] }) {
  const [item, setItem] = useState(initialItem)
  const [locationId, setLocationId] = useState(String(initialItem.location?.id ?? locations[0]?.id ?? ''))
  const [loading, setLoading] = useState(false)
  const [tracking, setTracking] = useState(false)

  async function onLocationChange(id: string) {
    setLocationId(id)
    if (!id) return
    setLoading(true)
    try {
      const res = await fetch(`/api/market-watch/${item.type_id}?location_id=${id}`)
      if (res.ok) setItem(await res.json())
    } finally {
      setLoading(false)
    }
  }

  async function trackItem() {
    setTracking(true)
    try {
      await fetch('/api/market-watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type_id: item.type_id }),
      })
      setItem(prev => ({ ...prev, tracked: true }))
    } finally {
      setTracking(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="text-[18px] font-medium text-primary">{item.name}</div>
          <div className="text-[12px] text-faint">type_id {item.type_id}</div>
        </div>
        <div className="flex items-center gap-3">
          <select value={locationId} onChange={e => onLocationChange(e.target.value)} className={INPUT}>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          {!item.tracked && (
            <button onClick={trackItem} disabled={tracking} className={BTN_SM_PRIMARY}>
              {tracking ? 'Tracking…' : '+ Track this item'}
            </button>
          )}
        </div>
      </div>

      <div className={loading ? 'space-y-6 opacity-50 transition-opacity' : 'space-y-6 transition-opacity'}>
        {/* Price history */}
        <div className={CARD}>
          <div className={SECTION}>Region price history</div>
          {item.history.length === 0 ? (
            <div className={EMPTY}>No price history available for this region.</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={item.history} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={fmtDateShort} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tickFormatter={v => iska(v)} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} width={52} />
                  <Tooltip content={<HistoryTooltip />} />
                  <Line type="monotone" dataKey="highest" stroke="var(--green)" strokeOpacity={0.5} strokeWidth={1} dot={false} />
                  <Line type="monotone" dataKey="lowest" stroke="var(--red)" strokeOpacity={0.5} strokeWidth={1} dot={false} />
                  <Line type="monotone" dataKey="average" stroke="var(--accent)" strokeWidth={2} dot={false} activeDot={{ r: 3, fill: 'var(--accent)' }} />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-5 mt-3 text-[11px] text-muted">
                <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-accent inline-block" /> Average</span>
                <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-eve-green/50 inline-block" /> High</span>
                <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-eve-red/50 inline-block" /> Low</span>
              </div>
            </>
          )}
        </div>

        {/* Velocity */}
        <div className={CARD}>
          <div className={SECTION}>Region trading volume (velocity)</div>
          {item.velocity.length === 0 ? (
            <div className={EMPTY}>No trading volume data available for this region.</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={item.velocity} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={fmtDateShort} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis yAxisId="volume" tickFormatter={v => iska(v)} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} width={52} />
                  <YAxis yAxisId="orders" orientation="right" tickFormatter={v => v.toLocaleString()} tick={{ fill: 'var(--accent)', fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
                  <Tooltip content={<VelocityTooltip />} />
                  <Bar yAxisId="volume" dataKey="volume" fill="var(--green)" fillOpacity={0.6} radius={[2, 2, 0, 0]} />
                  <Line yAxisId="orders" type="monotone" dataKey="order_count" stroke="var(--accent)" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-5 mt-3 text-[11px] text-muted">
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-eve-green/60 inline-block" /> Units traded/day</span>
                <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-accent inline-block" /> Order count (right axis)</span>
              </div>
            </>
          )}
        </div>

        {/* Depth */}
        <div className={CARD}>
          <div className="flex items-center justify-between mb-4">
            <div className="text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">
              Order book depth — {item.location?.name ?? 'no location'}
            </div>
            <div className="text-[11px] text-faint">Data as of {fmtSynced(item.data_as_of)}</div>
          </div>
          {item.depth.buy.length === 0 && item.depth.sell.length === 0 ? (
            <div className={EMPTY}>No order book data for this location yet — it may not have been polled.</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis type="number" dataKey="price" tickFormatter={v => iska(v)} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} domain={['dataMin', 'dataMax']} />
                  <YAxis tickFormatter={v => v.toLocaleString()} tick={{ fill: 'var(--text-muted)', fontSize: 10 }} axisLine={false} tickLine={false} width={52} />
                  <Tooltip content={<DepthTooltip />} />
                  <Line data={item.depth.buy} dataKey="cumulative" name="Buy" type="stepAfter" stroke="var(--green)" strokeWidth={2} dot={false} />
                  <Line data={item.depth.sell} dataKey="cumulative" name="Sell" type="stepAfter" stroke="var(--red)" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-5 mt-3 text-[11px] text-muted">
                <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-eve-green inline-block" /> Buy orders</span>
                <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-eve-red inline-block" /> Sell orders</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
