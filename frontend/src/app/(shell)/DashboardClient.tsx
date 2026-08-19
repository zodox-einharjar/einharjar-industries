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
  doctrine_summary: DoctrineSummary[]
  alerts: Alert[]
}

interface MarketListingLite {
  order_id: number
  item_name: string
  location_name: string
  list_price: number
  qty_remaining: number
  market_low: number | null
  is_undercut: boolean
}

interface ContractLite {
  contract_id: number
  status: string
  direction: 'incoming' | 'outgoing'
  issuer_name: string | null
  price: number | null
  reward: number | null
  date_expired: string
}

interface IndustryProjectLite {
  id: number
  name: string
  status: 'planning' | 'in_progress' | 'complete'
}

interface IndustryJobLite {
  id: number
  status: string
  end_date: string
  product_name: string | null
  blueprint_name: string | null
}

interface ActiveOperationLite {
  state: string
  expires: string
  dungeon_name: string | null
}

interface MercenaryDenLite {
  id: number
  type_name: string | null
  planet_name: string | null
  state: string
  development_level: string
  anarchy_level: string
  anarchy_amount: number
  reinforced_until: string | null
  active_operation: ActiveOperationLite | null
}

interface AttentionItem {
  key: string
  severity: 'danger' | 'warn'
  title: string
  detail: string
  href: string
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

function fmtRemaining(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now()
  if (diffMs <= 0) return 'Done'
  const days  = Math.floor(diffMs / 86_400_000)
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000)
  const mins  = Math.floor((diffMs % 3_600_000) / 60_000)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function levelIndex(level: string): number {
  return parseInt(level.replace('Level', ''), 10) || 0
}

// Same tiering as the Anarchy meter on the Mercenary Dens page: green below
// 15/20 in Level0, yellow from 15/20, orange in Level1, red from Level2 up.
function anarchyTier(level: string, amount: number): 'green' | 'yellow' | 'orange' | 'red' {
  const idx = levelIndex(level)
  if (idx <= 0) return amount >= 15 ? 'yellow' : 'green'
  if (idx === 1) return 'orange'
  return 'red'
}

const ANARCHY_DOT: Record<string, string> = {
  green: 'bg-eve-green', yellow: 'bg-eve-yellow', orange: 'bg-eve-amber', red: 'bg-eve-red',
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

const PROJECT_STATUS_LABEL: Record<string, string> = {
  planning: 'Planning', in_progress: 'In progress', complete: 'Complete',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, variant }: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
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

function EmptyRow({ text }: { text: string }) {
  return <p className="text-[12px] text-faint py-3 text-center">{text}</p>
}

function Row({ href, left, right }: { href: string; left: React.ReactNode; right: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 py-1.5 px-1 -mx-1 rounded border-b border-wire-dim last:border-0 hover:bg-canvas transition-colors"
    >
      <span className="text-[13px] text-primary truncate min-w-0">{left}</span>
      <span className="flex items-center gap-2 flex-shrink-0 text-[11px]">{right}</span>
    </Link>
  )
}

const LINK_SM = 'text-[11px] text-muted hover:text-accent transition-colors'

// ── Main component ────────────────────────────────────────────────────────────

export function DashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [pnlDaily, setPnlDaily] = useState<DailyPnl[]>([])
  const [pnlSummary, setPnlSummary] = useState<PnlSummary | null>(null)
  const [listings, setListings] = useState<MarketListingLite[]>([])
  const [contracts, setContracts] = useState<ContractLite[]>([])
  const [projects, setProjects] = useState<IndustryProjectLite[]>([])
  const [jobs, setJobs] = useState<IndustryJobLite[]>([])
  const [dens, setDens] = useState<MercenaryDenLite[]>([])

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

  const loadExtras = useCallback(() => {
    fetch('/api/inventory/pnl?days=30')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { setPnlDaily(d.daily); setPnlSummary(d.summary) } })
      .catch(() => {})
    fetch('/api/market-listings')
      .then(r => r.ok ? r.json() : [])
      .then(setListings)
      .catch(() => {})
    fetch('/api/contracts')
      .then(r => r.ok ? r.json() : [])
      .then(setContracts)
      .catch(() => {})
    fetch('/api/industry')
      .then(r => r.ok ? r.json() : [])
      .then(setProjects)
      .catch(() => {})
    fetch('/api/industry/jobs')
      .then(r => r.ok ? r.json() : [])
      .then(setJobs)
      .catch(() => {})
    fetch('/api/mercenary/dens')
      .then(r => r.ok ? r.json() : [])
      .then(setDens)
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadExtras()
    const id = setInterval(loadExtras, 60000)
    return () => clearInterval(id)
  }, [loadExtras])

  if (loading) return <LoadingSkeleton />
  if (!data) return null

  // ── Derived stats ─────────────────────────────────────────────────────────
  const marketValue = listings.reduce((sum, l) => sum + l.list_price * l.qty_remaining, 0)
  const undercutListings = listings.filter(l => l.is_undercut)

  const outstandingContracts = contracts.filter(c => c.status === 'outstanding')
  const incomingOutstanding = outstandingContracts.filter(c => c.direction === 'incoming')

  const activeJobs = jobs.filter(j => j.status === 'active' || j.status === 'paused' || j.status === 'ready')
  const nextJob = [...activeJobs].sort((a, b) => a.end_date.localeCompare(b.end_date))[0]

  const inProgressProjects = projects.filter(p => p.status === 'in_progress')

  const reinforcedDens = dens.filter(d => d.reinforced_until)
  const densAtRisk = dens.filter(d => d.reinforced_until || anarchyTier(d.anarchy_level, d.anarchy_amount) === 'orange' || anarchyTier(d.anarchy_level, d.anarchy_amount) === 'red')

  const sortedDens = [...dens].sort((a, b) => {
    const score = (d: MercenaryDenLite) => (d.reinforced_until ? 3 : d.active_operation ? 2 : anarchyTier(d.anarchy_level, d.anarchy_amount) !== 'green' ? 1 : 0)
    return score(b) - score(a)
  })

  const attentionItems: AttentionItem[] = [
    ...data.alerts.map(a => ({
      key: `doctrine-${a.doctrine_id}-${a.fit_name}`,
      severity: a.severity,
      title: a.fit_name ?? 'Fit short',
      detail: `${a.doctrine_name ? a.doctrine_name + ' · ' : ''}${a.detail}`,
      href: '/doctrines',
    })),
    ...reinforcedDens.map(d => ({
      key: `den-${d.id}`,
      severity: 'danger' as const,
      title: `${d.type_name ?? 'Den'} reinforced`,
      detail: d.planet_name ?? '',
      href: '/mercenary',
    })),
    ...incomingOutstanding.map(c => ({
      key: `contract-${c.contract_id}`,
      severity: 'warn' as const,
      title: 'Incoming contract',
      detail: `${c.issuer_name ?? 'Unknown'} · ${iska(c.price ?? c.reward)}`,
      href: '/contracts',
    })),
    ...undercutListings.map(l => ({
      key: `listing-${l.order_id}`,
      severity: 'warn' as const,
      title: `${l.item_name} undercut`,
      detail: `${l.location_name} · listed ${iska(l.list_price)}, market ${iska(l.market_low)}`,
      href: '/market-orders',
    })),
  ]
  const topAttention = [...attentionItems]
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'danger' ? -1 : 1))
    .slice(0, 6)
  const attentionOverflow = attentionItems.length - topAttention.length

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="flex gap-3 flex-wrap">
        <StatCard
          label="ISK made (30d)"
          value={pnlSummary ? `${pnlSummary.total_profit >= 0 ? '+' : ''}${iska(pnlSummary.total_profit)}` : '—'}
          sub={pnlSummary ? `${pnlSummary.roi_pct >= 0 ? '+' : ''}${pnlSummary.roi_pct.toFixed(1)}% ROI` : undefined}
          variant={pnlSummary && pnlSummary.total_profit < 0 ? 'red' : 'green'}
        />
        <StatCard
          label="Market value"
          value={iska(marketValue)}
          sub={undercutListings.length > 0 ? <span className="text-eve-red">{undercutListings.length} undercut</span> : 'no undercuts'}
        />
        <StatCard
          label="Open contracts"
          value={outstandingContracts.length}
          sub={incomingOutstanding.length > 0 ? <span className="text-eve-red">{incomingOutstanding.length} incoming</span> : 'none incoming'}
          variant={incomingOutstanding.length > 0 ? 'red' : undefined}
        />
        <StatCard
          label="Active jobs"
          value={activeJobs.length}
          sub={nextJob ? `next in ${fmtRemaining(nextJob.end_date)}` : 'none running'}
        />
        <StatCard
          label="Dens at risk"
          value={densAtRisk.length}
          sub={reinforcedDens.length > 0 ? <span className="text-eve-red">{reinforcedDens.length} reinforced</span> : densAtRisk.length > 0 ? 'anarchy rising' : 'all calm'}
          variant={reinforcedDens.length > 0 ? 'red' : undefined}
        />
      </div>

      {/* P&L chart */}
      {pnlDaily.length > 0 && (
        <div className="bg-surface border border-wire rounded p-4">
          <div className="flex items-center justify-between mb-4">
            <span className="text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">30-day P&amp;L</span>
            <Link href="/pnl" className={LINK_SM}>View history →</Link>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={pnlDaily} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="var(--accent)" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={d => { const [,m,day] = d.split('-'); return `${parseInt(m)}/${parseInt(day)}` }}
                tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
                axisLine={false} tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tickFormatter={v => iska(v)}
                tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
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

      {/* Needs attention */}
      <div className="bg-surface border border-wire rounded p-4">
        <SectionHeader title="Needs attention" />
        {topAttention.length === 0 ? (
          <div className="flex items-center gap-2 py-4 px-3 rounded border border-eve-green/30 bg-eve-green/5">
            <span className="w-2 h-2 rounded-full bg-eve-green flex-shrink-0" />
            <span className="text-[13px] text-eve-green">Nothing needs attention right now.</span>
          </div>
        ) : (
          <div className="space-y-2">
            {topAttention.map(item => {
              const isDanger = item.severity === 'danger'
              const borderColor = isDanger ? 'var(--red)' : 'var(--amber)'
              const titleColor = isDanger ? 'text-eve-red' : 'text-eve-amber'
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  className="block pl-3 pr-3 py-2 rounded-r border border-wire border-l-2 bg-canvas hover:bg-surface-hi transition-colors"
                  style={{ borderLeftColor: borderColor }}
                >
                  <div className={`text-[12px] font-semibold ${titleColor}`}>{item.title}</div>
                  <div className="text-[11px] text-muted mt-0.5">{item.detail}</div>
                </Link>
              )
            })}
            {attentionOverflow > 0 && (
              <div className="text-[11px] text-faint pt-1">+{attentionOverflow} more</div>
            )}
          </div>
        )}
      </div>

      {/* Doctrines + Mercenary dens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-wire rounded p-4">
          <SectionHeader
            title="Doctrine availability"
            action={<Link href="/doctrines" className={LINK_SM}>View all →</Link>}
          />
          {data.doctrine_summary.length === 0 ? (
            <EmptyRow text="No doctrines configured yet." />
          ) : (
            <div>
              {data.doctrine_summary.map(d => (
                <Row
                  key={d.id}
                  href={`/doctrines/${d.id}`}
                  left={d.name}
                  right={<>
                    <span className="text-muted font-mono">{d.fits_stocked}/{d.fits_total}</span>
                    <span className={`px-1.5 py-0.5 rounded border font-medium ${STATUS_PILL[d.status]}`}>
                      {STATUS_LABEL[d.status]}
                    </span>
                  </>}
                />
              ))}
            </div>
          )}
        </div>

        <div className="bg-surface border border-wire rounded p-4">
          <SectionHeader
            title="Mercenary dens"
            action={<Link href="/mercenary" className={LINK_SM}>View all →</Link>}
          />
          {sortedDens.length === 0 ? (
            <EmptyRow text="No mercenary dens tracked." />
          ) : (
            <div>
              {sortedDens.slice(0, 6).map(d => (
                <Row
                  key={d.id}
                  href="/mercenary"
                  left={<>{d.type_name ?? 'Den'} <span className="text-faint">· {d.planet_name}</span></>}
                  right={<>
                    <span className={`w-1.5 h-1.5 rounded-full ${ANARCHY_DOT[anarchyTier(d.anarchy_level, d.anarchy_amount)]}`} title="Anarchy" />
                    <span className="text-muted font-mono">{d.development_level.replace('Level', 'L')}</span>
                    {d.reinforced_until ? (
                      <span className="text-eve-red">reinforced</span>
                    ) : d.active_operation ? (
                      <span className="text-accent">MTO</span>
                    ) : null}
                  </>}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Industry + Market & Contracts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-wire rounded p-4">
          <SectionHeader
            title="Industry"
            action={<Link href="/industry" className={LINK_SM}>View all →</Link>}
          />
          {inProgressProjects.length === 0 ? (
            <EmptyRow text="No projects in progress." />
          ) : (
            <div>
              {inProgressProjects.slice(0, 4).map(p => (
                <Row
                  key={p.id}
                  href="/industry"
                  left={p.name}
                  right={<span className="text-accent">{PROJECT_STATUS_LABEL[p.status]}</span>}
                />
              ))}
            </div>
          )}
          <div className="mt-3 pt-3 border-t border-wire-dim">
            <div className="text-[11px] text-faint uppercase tracking-wide mb-1">Jobs completing soon</div>
            {activeJobs.length === 0 ? (
              <EmptyRow text="No active jobs." />
            ) : (
              [...activeJobs].sort((a, b) => a.end_date.localeCompare(b.end_date)).slice(0, 4).map(j => (
                <Row
                  key={j.id}
                  href="/industry/jobs"
                  left={j.product_name ?? j.blueprint_name ?? 'Job'}
                  right={<span className="text-muted font-mono">{fmtRemaining(j.end_date)}</span>}
                />
              ))
            )}
          </div>
        </div>

        <div className="bg-surface border border-wire rounded p-4">
          <SectionHeader
            title="Market & contracts"
            action={<Link href="/market-orders" className={LINK_SM}>Orders →</Link>}
          />
          {undercutListings.length === 0 ? (
            <EmptyRow text="No undercut listings." />
          ) : (
            <div>
              {undercutListings.slice(0, 4).map(l => (
                <Row
                  key={l.order_id}
                  href="/market-orders"
                  left={<>{l.item_name} <span className="text-faint">· {l.location_name}</span></>}
                  right={<span className="text-eve-red font-mono">{iska(l.list_price)} → {iska(l.market_low)}</span>}
                />
              ))}
            </div>
          )}
          <div className="mt-3 pt-3 border-t border-wire-dim">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] text-faint uppercase tracking-wide">Outstanding contracts</span>
              <Link href="/contracts" className={LINK_SM}>Contracts →</Link>
            </div>
            {outstandingContracts.length === 0 ? (
              <EmptyRow text="No outstanding contracts." />
            ) : (
              outstandingContracts.slice(0, 4).map(c => (
                <Row
                  key={c.contract_id}
                  href="/contracts"
                  left={<>{c.issuer_name ?? 'Unknown'} {c.direction === 'incoming' && <span className="text-eve-amber">(incoming)</span>}</>}
                  right={<span className="text-muted font-mono">{iska(c.price ?? c.reward)}</span>}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex gap-3 flex-wrap">
        {[0, 1, 2, 3, 4].map(i => <SkeletonCard key={i} />)}
      </div>
      <div className="bg-surface border border-wire rounded p-4 h-24" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-wire rounded p-4 h-48" />
        <div className="bg-surface border border-wire rounded p-4 h-48" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-wire rounded p-4 h-48" />
        <div className="bg-surface border border-wire rounded p-4 h-48" />
      </div>
    </div>
  )
}
