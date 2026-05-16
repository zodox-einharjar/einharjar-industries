'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DailyPoint {
  date: string
  revenue: number
  cost: number
  profit: number
  cumulative_profit: number
}

interface Entry {
  id: number
  sold_at: string
  date: string
  item_name: string
  qty: number
  unit_cost: number
  unit_sell_price: number
  revenue: number | null
  cost: number
  profit: number | null
  location_name: string
}

interface Summary {
  total_revenue: number
  total_cost: number
  total_profit: number
  roi_pct: number
  sold_count: number
  priced_count: number
}

interface PnlData {
  daily: DailyPoint[]
  entries: Entry[]
  summary: Summary
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

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function fmtDateShort(dateStr: string): string {
  const [, m, d] = dateStr.split('-')
  return `${parseInt(m)}/${parseInt(d)}`
}

const PERIODS = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '1y',  days: 365 },
  { label: 'All', days: 0 },
]

// ── Custom tooltip ────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const profit = payload.find((p: any) => p.dataKey === 'profit')?.value
  const cumulative = payload.find((p: any) => p.dataKey === 'cumulative_profit')?.value
  return (
    <div className="bg-surface border border-wire rounded px-3 py-2 text-[12px] shadow-lg">
      <div className="text-muted mb-1">{label}</div>
      {profit !== undefined && (
        <div className={profit >= 0 ? 'text-eve-green' : 'text-eve-red'}>
          Day: {profit >= 0 ? '+' : ''}{iska(profit)}
        </div>
      )}
      {cumulative !== undefined && (
        <div className={`text-accent mt-0.5`}>
          Cumulative: {cumulative >= 0 ? '+' : ''}{iska(cumulative)}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function PnlClient() {
  const [data, setData] = useState<PnlData | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState(30)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const q = period > 0 ? `?days=${period}` : ''
      const r = await fetch(`/api/inventory/pnl${q}`)
      if (r.ok) setData(await r.json())
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { load() }, [load])

  const profitColor = (v: number) => v >= 0 ? 'var(--green)' : 'var(--red)'

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="flex items-center gap-2">
        {PERIODS.map(p => (
          <button
            key={p.label}
            onClick={() => setPeriod(p.days)}
            className={`px-3 py-1 text-[12px] rounded border transition-colors ${
              period === p.days
                ? 'border-accent text-accent bg-accent/10'
                : 'border-wire text-muted hover:text-secondary'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-4 animate-pulse">
          <div className="flex gap-3">{[0,1,2,3].map(i => <div key={i} className="flex-1 h-20 bg-surface border border-wire rounded" />)}</div>
          <div className="h-64 bg-surface border border-wire rounded" />
        </div>
      ) : !data ? null : (
        <>
          {/* Summary cards */}
          <div className="flex gap-3 flex-wrap">
            {[
              { label: 'Revenue',  value: iska(data.summary.total_revenue), color: '' },
              { label: 'Cost',     value: iska(data.summary.total_cost),    color: 'text-muted' },
              { label: 'Profit',   value: (data.summary.total_profit >= 0 ? '+' : '') + iska(data.summary.total_profit), color: data.summary.total_profit >= 0 ? 'text-eve-green' : 'text-eve-red' },
              { label: 'ROI',      value: (data.summary.roi_pct >= 0 ? '+' : '') + data.summary.roi_pct.toFixed(1) + '%', color: data.summary.roi_pct >= 0 ? 'text-eve-green' : 'text-eve-red' },
            ].map(c => (
              <div key={c.label} className="bg-surface border border-wire rounded px-4 py-3 flex-1 min-w-[130px]">
                <div className={`text-[20px] font-medium font-mono leading-tight ${c.color || 'text-primary'}`}>{c.value}</div>
                <div className="text-[11px] text-muted mt-0.5">{c.label}</div>
              </div>
            ))}
            <div className="bg-surface border border-wire rounded px-4 py-3 flex-1 min-w-[130px]">
              <div className="text-[20px] font-medium font-mono leading-tight text-primary">{data.summary.priced_count}</div>
              <div className="text-[11px] text-muted mt-0.5">sales with price</div>
              {data.summary.sold_count > data.summary.priced_count && (
                <div className="text-[11px] text-faint">{data.summary.sold_count - data.summary.priced_count} without</div>
              )}
            </div>
          </div>

          {/* Chart */}
          {data.daily.length === 0 ? (
            <div className="bg-surface border border-wire rounded p-8 text-center text-muted text-[13px]">
              No sales with recorded prices yet. Enter sell prices when marking items as sold to track P&amp;L.
            </div>
          ) : (
            <div className="bg-surface border border-wire rounded p-4">
              <div className="text-[11px] font-semibold tracking-[0.1em] text-faint uppercase mb-4">P&amp;L over time</div>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={data.daily} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--wire)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={fmtDateShort}
                    tick={{ fill: 'var(--muted)', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    yAxisId="daily"
                    tickFormatter={v => iska(v)}
                    tick={{ fill: 'var(--muted)', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                  />
                  <YAxis
                    yAxisId="cumul"
                    orientation="right"
                    tickFormatter={v => iska(v)}
                    tick={{ fill: 'var(--accent)', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <ReferenceLine yAxisId="daily" y={0} stroke="var(--wire)" />
                  <Bar
                    yAxisId="daily"
                    dataKey="profit"
                    fill="var(--green)"
                    radius={[2, 2, 0, 0]}
                    // colour each bar individually
                    // @ts-ignore
                    shape={(props: any) => {
                      const { x, y, width, height, value } = props
                      const fill = value >= 0 ? 'var(--green)' : 'var(--red)'
                      const h = Math.abs(height)
                      const ty = value >= 0 ? y : y + height
                      return <rect x={x} y={ty} width={width} height={h} fill={fill} fillOpacity={0.7} rx={2} />
                    }}
                  />
                  <Line
                    yAxisId="cumul"
                    type="monotone"
                    dataKey="cumulative_profit"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3, fill: 'var(--accent)' }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-5 mt-3 text-[11px] text-muted">
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-eve-green/70 inline-block" /> Daily P&amp;L</span>
                <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-accent inline-block" /> Cumulative (right axis)</span>
              </div>
            </div>
          )}

          {/* History table */}
          {data.entries.length > 0 && (
            <div className="bg-surface border border-wire rounded overflow-hidden">
              <div className="px-4 py-3 border-b border-wire">
                <span className="text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">Sale history</span>
              </div>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-wire bg-canvas">
                    <th className="text-left px-4 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Date</th>
                    <th className="text-left px-4 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Item</th>
                    <th className="text-right px-4 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Qty</th>
                    <th className="text-right px-4 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Cost/u</th>
                    <th className="text-right px-4 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Sell/u</th>
                    <th className="text-right px-4 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Profit</th>
                    <th className="text-left px-4 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider">Location</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map(e => (
                    <tr key={e.id} className="border-t border-wire-dim hover:bg-canvas transition-colors">
                      <td className="px-4 py-2 font-mono text-faint whitespace-nowrap">{fmtDate(e.sold_at)}</td>
                      <td className="px-4 py-2 text-primary max-w-[200px] truncate" title={e.item_name}>{e.item_name}</td>
                      <td className="px-4 py-2 text-right font-mono text-secondary">{e.qty.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right font-mono text-muted">{iska(e.unit_cost)}</td>
                      <td className="px-4 py-2 text-right font-mono text-secondary">
                        {e.unit_sell_price > 0 ? iska(e.unit_sell_price) : <span className="text-faint">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        {e.profit != null ? (
                          <span className={e.profit >= 0 ? 'text-eve-green' : 'text-eve-red'}>
                            {e.profit >= 0 ? '+' : ''}{iska(e.profit)}
                          </span>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted truncate max-w-[160px]" title={e.location_name}>{e.location_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
