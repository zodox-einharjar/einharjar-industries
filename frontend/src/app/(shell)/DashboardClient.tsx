'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  CartesianGrid, ResponsiveContainer,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DoctrineSummary {
  id: number
  name: string
  status: 'ready' | 'partial' | 'short' | 'unknown'
  fits_stocked: number
  fits_total: number
}

interface Alert {
  type: 'fit_short' | 'poll_overdue'
  doctrine_id?: number
  doctrine_name?: string
  fit_name?: string
  detail: string
  severity: 'danger' | 'warn'
}

interface ItemToSource {
  type_id: number
  name: string
  qty_needed: number
  source: 'import' | 'staging'
  jita_price: number | null
}

interface DailyPnl {
  date: string
  profit: number
  cumulative_profit: number
}

interface PnlSummary {
  total_profit: number
  roi_pct: number
  priced_count: number
}

interface DashboardData {
  doctrine_count: number
  doctrines_fully_stocked: number
  fits_below_target: number
  location_count: number
  location_names: string[]
  import_savings_isk: number
  last_poll: string | null
  next_poll: string | null
  doctrine_summary: DoctrineSummary[]
  alerts: Alert[]
  items_to_source: ItemToSource[]
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



const STATUS_PILL: Record<string, string> = {
  ready:   'border-eve-green text-eve-green',
  partial: 'border-eve-amber text-eve-amber',
  short:   'border-eve-red text-eve-red',
  unknown: 'border-wire text-muted',
}
const STATUS_LABEL: Record<string, string> = {
  ready: 'Ready', partial: 'Partial', short: 'Short', unknown: '—',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, variant }: {
  label: string
  value: React.ReactNode
  sub?: string
  variant?: 'red' | 'green' | 'blue'
}) {
  const cls = variant === 'red' ? 'text-eve-red' : variant === 'green' ? 'text-eve-green' : variant === 'blue' ? 'text-accent' : 'text-primary'
  return (
    <div className="bg-surface border border-wire rounded px-4 py-3 flex-1 min-w-[140px]">
      <div className={`text-[20px] font-medium font-mono leading-tight ${cls}`}>{value}</div>
      <div className="text-[11px] text-muted mt-0.5">{label}</div>
      {sub && <div className="text-[11px] text-faint mt-0.5 truncate">{sub}</div>}
    </div>
  )
}

function SkeletonCard() {
  return (
    <div className="bg-surface border border-wire rounded px-4 py-3 flex-1 min-w-[140px] animate-pulse">
      <div className="h-6 bg-wire rounded w-16 mb-2" />
      <div className="h-3 bg-wire rounded w-24" />
    </div>
  )
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <span className="text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">{title}</span>
      {action}
    </div>
  )
}

const LINK_SM = 'text-[11px] text-muted hover:text-accent transition-colors'

// ── Main component ────────────────────────────────────────────────────────────

export function DashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [pnlDaily, setPnlDaily] = useState<DailyPnl[]>([])
  const [pnlSummary, setPnlSummary] = useState<PnlSummary | null>(null)

  const fetch_ = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true)
    try {
      const res = await fetch('/api/dashboard')
      if (!res.ok) throw new Error()
      const json: DashboardData = await res.json()
      setData(json)
    } catch {
    } finally {
      if (initial) setLoading(false)
    }
  }, [])

  useEffect(() => { fetch_(true) }, [fetch_])
  useEffect(() => {
    const id = setInterval(() => fetch_(false), 60000)
    return () => clearInterval(id)
  }, [fetch_])

  useEffect(() => {
    fetch('/api/inventory/pnl?days=30')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { setPnlDaily(d.daily); setPnlSummary(d.summary) } })
      .catch(() => {})
  }, [])

  if (loading) return <LoadingSkeleton />
  if (!data) return null

  const locSubLabel = data.location_names.length <= 2
    ? data.location_names.join(', ')
    : data.location_names.slice(0, 2).join(', ') + ` +${data.location_names.length - 2}`

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="flex gap-3 flex-wrap">
        <StatCard
          label="Active doctrines"
          value={data.doctrine_count}
          sub={`${data.doctrines_fully_stocked} fully stocked`}
        />
        <StatCard
          label="Fits below target"
          value={data.fits_below_target}
          sub="need restocking"
          variant={data.fits_below_target > 0 ? 'red' : undefined}
        />
        <StatCard
          label="Market locations"
          value={data.location_count}
          sub={locSubLabel || '—'}
        />
        <StatCard
          label="Import savings"
          value={iska(data.import_savings_isk)}
          sub="vs staging buy"
          variant="green"
        />
      </div>

      {/* P&L chart */}
      {pnlDaily.length > 0 && (
        <div className="bg-surface border border-wire rounded p-4">
          <div className="flex items-center justify-between mb-4">
            <span className="text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">30-day P&amp;L</span>
            <div className="flex items-center gap-4 text-[12px]">
              {pnlSummary && (
                <span className={pnlSummary.total_profit >= 0 ? 'text-eve-green' : 'text-eve-red'}>
                  {pnlSummary.total_profit >= 0 ? '+' : ''}{iska(pnlSummary.total_profit)}
                  {' '}({pnlSummary.roi_pct >= 0 ? '+' : ''}{pnlSummary.roi_pct.toFixed(1)}% ROI)
                </span>
              )}
              <Link href="/pnl" className={LINK_SM}>View history →</Link>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={pnlDaily} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="var(--accent)" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--wire)" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={d => { const [,m,day] = d.split('-'); return `${parseInt(m)}/${parseInt(day)}` }}
                tick={{ fill: 'var(--muted)', fontSize: 10 }}
                axisLine={false} tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tickFormatter={v => iska(v)}
                tick={{ fill: 'var(--muted)', fontSize: 10 }}
                axisLine={false} tickLine={false} width={48}
              />
              <Tooltip
                content={({ active, payload, label }: any) => {
                  if (!active || !payload?.length) return null
                  const val = payload[0]?.value
                  return (
                    <div className="bg-surface border border-wire rounded px-3 py-2 text-[12px] shadow-lg">
                      <div className="text-muted mb-0.5">{label}</div>
                      <div className={val >= 0 ? 'text-eve-green' : 'text-eve-red'}>
                        {val >= 0 ? '+' : ''}{iska(val)}
                      </div>
                    </div>
                  )
                }}
              />
              <Area
                type="monotone"
                dataKey="cumulative_profit"
                stroke="var(--accent)"
                strokeWidth={2}
                fill="url(#pnlGradient)"
                dot={false}
                activeDot={{ r: 3, fill: 'var(--accent)' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Two-column: doctrine table + alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Doctrine availability */}
        <div className="bg-surface border border-wire rounded p-4">
          <SectionHeader
            title="Doctrine availability"
            action={<Link href="/doctrines" className={LINK_SM}>View all →</Link>}
          />
          {data.doctrine_summary.length === 0 ? (
            <div className="py-6 text-center space-y-1">
              <p className="text-[12px] text-muted">No doctrines configured yet.</p>
              <p className="text-[11px] text-faint">
                Add a{' '}
                <Link href="/settings" className="text-accent hover:underline">location</Link>
                {', then '}
                <Link href="/doctrines" className="text-accent hover:underline">create a doctrine</Link>
                .
              </p>
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-wire">
                  <th className="text-left text-[11px] text-faint font-normal pb-2">Doctrine</th>
                  <th className="text-right text-[11px] text-faint font-normal pb-2">Fits</th>
                  <th className="text-right text-[11px] text-faint font-normal pb-2 pl-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.doctrine_summary.map(d => (
                  <tr key={d.id} className="border-b border-wire-dim last:border-0 hover:bg-canvas transition-colors">
                    <td className="py-2 pr-2">
                      <Link href={`/doctrines/${d.id}`} className="text-[13px] text-primary hover:text-accent transition-colors">
                        {d.name}
                      </Link>
                    </td>
                    <td className="py-2 text-right font-mono text-[12px] text-secondary tabular-nums">
                      {d.fits_stocked} / {d.fits_total}
                    </td>
                    <td className="py-2 pl-4 text-right">
                      <span className={`text-[11px] px-1.5 py-0.5 rounded border font-medium ${STATUS_PILL[d.status]}`}>
                        {STATUS_LABEL[d.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Alerts */}
        <div className="bg-surface border border-wire rounded p-4">
          <SectionHeader title="Alerts" />
          {data.alerts.length === 0 ? (
            <div className="flex items-center gap-2 py-4 px-3 rounded border border-eve-green/30 bg-eve-green/5">
              <span className="w-2 h-2 rounded-full bg-eve-green flex-shrink-0" />
              <span className="text-[13px] text-eve-green">
                {data.doctrine_count === 0 ? 'No doctrines configured' : 'All doctrines fully stocked'}
              </span>
            </div>
          ) : (
            <div className="space-y-2">
              {data.alerts.map((alert, i) => {
                const isDanger = alert.severity === 'danger'
                const borderColor = isDanger ? 'var(--red)' : 'var(--amber)'
                const titleColor = isDanger ? 'text-eve-red' : 'text-eve-amber'
                const title = alert.type === 'fit_short'
                  ? alert.fit_name ?? 'Unknown fit'
                  : 'Poll overdue'
                return (
                  <div
                    key={i}
                    className="pl-3 pr-3 py-2 rounded-r border border-wire border-l-2 bg-canvas"
                    style={{ borderLeftColor: borderColor }}
                  >
                    <div className={`text-[12px] font-semibold ${titleColor}`}>{title}</div>
                    <div className="text-[11px] text-muted mt-0.5">
                      {alert.doctrine_name && (
                        <span className="text-secondary">{alert.doctrine_name} · </span>
                      )}
                      {alert.detail}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Items to source */}
      {data.items_to_source.length > 0 && (
        <div className="bg-surface border border-wire rounded p-4">
          <SectionHeader
            title="Items to source"
            action={<Link href="/availability?below=1" className={LINK_SM}>Open in availability →</Link>}
          />
          <div className="space-y-0">
            {data.items_to_source.map(item => (
              <div
                key={item.type_id}
                className="flex items-center gap-3 py-2 border-b border-wire-dim last:border-0"
              >
                <span className="text-[13px] text-primary flex-1 min-w-0 truncate">{item.name}</span>
                <span className={`text-[11px] px-1.5 py-0.5 rounded border flex-shrink-0 ${
                  item.source === 'import' ? 'text-accent border-accent/50' : 'text-eve-green border-eve-green/50'
                }`}>
                  {item.source}
                </span>
                <span className="text-[12px] font-mono text-eve-red tabular-nums flex-shrink-0">
                  ×{item.qty_needed.toLocaleString()}
                </span>
                {item.jita_price && (
                  <span className="text-[11px] text-muted font-mono flex-shrink-0 w-20 text-right">
                    {iska(item.jita_price)}/u
                  </span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3">
            <Link href="/availability?below=1" className="text-[12px] text-accent hover:underline">
              View all shortfalls →
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex gap-3 flex-wrap">
        {[0, 1, 2, 3].map(i => <SkeletonCard key={i} />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-wire rounded p-4 h-48" />
        <div className="bg-surface border border-wire rounded p-4 h-48" />
      </div>
      <div className="bg-surface border border-wire rounded p-4 h-32" />
    </div>
  )
}
