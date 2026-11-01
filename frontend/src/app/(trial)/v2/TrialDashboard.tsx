'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  DoctrineReport, DoctrineTile, MarketFreshness, StatusLegend, agoText, isk, marketStale, minutesSince, sortDoctrines,
} from './_shared/doctrines'

// ── Types (subset of the classic dashboard's API responses) ──────────────────

interface DailyPnl { date: string; profit: number; cumulative_profit: number }
interface WalletSummary {
  configured: boolean
  total: number | null
  change: number | null
  wallets: { source: string; label: string; balance: number | null; error: string | null }[]
  series: { t: string; total: number }[]
}
interface PnlSummary { total_profit: number; roi_pct: number }
interface Listing {
  order_id: number
  item_name: string
  location_name: string
  list_price: number
  qty_remaining: number
  qty_total: number
  market_low: number | null
  is_undercut: boolean
  hours_remaining: number | null
}
interface Contract {
  contract_id: number
  status: string
  type: string
  title: string | null
  direction: 'incoming' | 'outgoing'
  issuer_name: string | null
  assignee_name: string | null
  price: number | null
  reward: number | null
  date_expired: string
}
interface Job { id: number; status: string; start_date: string; end_date: string; product_name: string | null; blueprint_name: string | null; runs?: number }
interface Den {
  id: number
  type_name: string | null
  planet_name: string | null
  anarchy_level: string
  anarchy_amount: number
  development_level: string
  reinforced_until: string | null
  active_operation: { dungeon_name: string | null } | null
}

interface Notice { key: string; severity: 'danger' | 'warn'; what: string; where: string; act: string; href: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function until(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'done'
  const d = Math.floor(ms / 86_400_000)
  const h = Math.floor((ms % 86_400_000) / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const CONTRACT_TYPE: Record<string, string> = {
  item_exchange: 'Item exchange', courier: 'Courier', auction: 'Auction', loan: 'Loan',
}

/** "Maller ×3, Nitrogen Fuel Block" — repeated names collapse into a count. */
function groupNames(names: string[], max = 3): string {
  const counts = new Map<string, number>()
  names.forEach(n => counts.set(n, (counts.get(n) ?? 0) + 1))
  const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
  return parts.length > max ? `${parts.slice(0, max).join(', ')} and ${parts.length - max} more` : parts.join(', ')
}

function anarchyTier(level: string, amount: number): 'green' | 'yellow' | 'orange' | 'red' {
  const idx = parseInt(level.replace('Level', ''), 10) || 0
  if (idx <= 0) return amount >= 15 ? 'yellow' : 'green'
  return idx === 1 ? 'orange' : 'red'
}

function getJson<T>(url: string, fallback: T): Promise<T> {
  return fetch(url).then(r => (r.ok ? r.json() : fallback)).catch(() => fallback)
}

// ── Profit chart ──────────────────────────────────────────────────────────────

function shortDate(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${parseInt(d, 10)}/${parseInt(m, 10)}`
}

/** Total across the chosen wallets over time (hourly points). */
function WalletChart({ series }: { series: WalletSummary['series'] }) {
  const data = series.map(p => ({ ...p, ms: new Date(p.t).getTime() }))
  return (
    <div className="v2-profit-chart" role="img" aria-label="Wallet total over the last 30 days">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--seam)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="ms" type="number" scale="time" domain={['dataMin', 'dataMax']}
            tickFormatter={ms => { const d = new Date(ms); return `${d.getDate()}/${d.getMonth() + 1}` }}
            tick={{ fill: 'var(--dust)', fontSize: 12 }} axisLine={{ stroke: 'var(--seam)' }} tickLine={false} minTickGap={32}
          />
          <YAxis
            tickFormatter={v => isk(v)} width={52} domain={['auto', 'auto']}
            tick={{ fill: 'var(--dust)', fontSize: 12 }} axisLine={false} tickLine={false}
          />
          <Tooltip
            cursor={{ stroke: 'var(--seam)' }}
            content={({ active, payload }: any) => active && payload?.length ? (
              <div className="v2-tip">
                <div className="v2-tip-date">{new Date(payload[0].payload.ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                <div>Total: <b>{isk(payload[0].payload.total)}</b></div>
              </div>
            ) : null}
          />
          <Line type="stepAfter" dataKey="total" stroke="var(--brass)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Daily profit as bars (green/red), running total as a brass line. */
function ProfitChart({ daily }: { daily: DailyPnl[] }) {
  return (
    <div className="v2-profit-chart" role="img" aria-label="Daily and cumulative profit over the last 30 days">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={daily} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--seam)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date" tickFormatter={shortDate} interval="preserveStartEnd" minTickGap={24}
            tick={{ fill: 'var(--dust)', fontSize: 12 }} axisLine={{ stroke: 'var(--seam)' }} tickLine={false}
          />
          <YAxis
            tickFormatter={v => isk(v)} width={52}
            tick={{ fill: 'var(--dust)', fontSize: 12 }} axisLine={false} tickLine={false}
          />
          <ReferenceLine y={0} stroke="var(--dim)" />
          <Tooltip
            cursor={{ fill: 'rgba(255, 255, 255, 0.04)' }}
            content={({ active, payload, label }: any) => active && payload?.length ? (
              <div className="v2-tip">
                <div className="v2-tip-date">{label}</div>
                <div>Day: <b className={payload[0].payload.profit >= 0 ? 'up' : 'down'}>{isk(payload[0].payload.profit)}</b></div>
                <div>Running total: <b>{isk(payload[0].payload.cumulative_profit)}</b></div>
              </div>
            ) : null}
          />
          <Bar dataKey="profit" maxBarSize={14} radius={[2, 2, 0, 0]} isAnimationActive={false}>
            {daily.map((d, i) => <Cell key={i} fill={d.profit >= 0 ? 'var(--sage)' : 'var(--flare)'} fillOpacity={0.7} />)}
          </Bar>
          <Line type="monotone" dataKey="cumulative_profit" stroke="var(--brass)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Doctrine status ───────────────────────────────────────────────────────────

function DoctrineBoard({ report }: { report: DoctrineReport }) {
  const doctrines = sortDoctrines(report.doctrine_summary)
  return (
    <section aria-labelledby="board-title">
      <div className="v2-board-head">
        <h2 id="board-title">Doctrine status</h2>
        <p>
          {report.doctrines_fully_stocked} of {report.doctrine_count} doctrines at target.{' '}
          <MarketFreshness lastPoll={report.last_poll} nextPoll={report.next_poll} />
        </p>
        <Link href="/v2/doctrines">See every fit</Link>
        <Link href="/v2/buying">Build a shopping list</Link>
      </div>
      <StatusLegend />
      {doctrines.length === 0 ? (
        <p className="v2-empty">
          No doctrines yet. <Link href="/doctrines" style={{ color: 'var(--brass)' }}>Add your first doctrine</Link> to track its stock here.
        </p>
      ) : (
        <div className="v2-tiles">
          {doctrines.map((d, i) => <DoctrineTile key={d.id} d={d} index={i} />)}
        </div>
      )}
    </section>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function TrialDashboard() {
  const [report, setReport] = useState<DoctrineReport | null>(null)
  const [failed, setFailed] = useState(false)
  const [pnl, setPnl] = useState<{ daily: DailyPnl[]; summary: PnlSummary } | null>(null)
  const [wallet, setWallet] = useState<WalletSummary | null>(null)
  const [listings, setListings] = useState<Listing[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [dens, setDens] = useState<Den[]>([])

  const load = useCallback(() => {
    fetch('/api/dashboard')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(r => { setReport(r); setFailed(false) })
      .catch(() => setFailed(true))
    getJson('/api/inventory/pnl?days=30', null).then(setPnl)
    getJson<WalletSummary | null>('/api/wallet/summary?days=30', null).then(setWallet)
    getJson<Listing[]>('/api/market-listings', []).then(setListings)
    getJson<Contract[]>('/api/contracts', []).then(setContracts)
    getJson<Job[]>('/api/industry/jobs', []).then(setJobs)
    getJson<Den[]>('/api/mercenary/dens', []).then(setDens)
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  const undercut = listings.filter(l => l.is_undercut)
  const outstanding = contracts.filter(c => c.status === 'outstanding')
  const incoming = outstanding.filter(c => c.direction === 'incoming')
  const running = jobs
    .filter(j => j.status === 'active' || j.status === 'paused' || j.status === 'ready')
    .sort((a, b) => a.end_date.localeCompare(b.end_date))
  const deliverable = running.filter(j => j.status === 'ready' || new Date(j.end_date).getTime() <= Date.now())
  const listedValue = listings.reduce((s, l) => s + l.list_price * l.qty_remaining, 0)
  // Undercut first, then orders about to expire, then by value on the market.
  const sortedListings = [...listings].sort((a, b) =>
    Number(b.is_undercut) - Number(a.is_undercut)
    || (a.hours_remaining ?? Infinity) - (b.hours_remaining ?? Infinity)
    || b.list_price * b.qty_remaining - a.list_price * a.qty_remaining)
  const sortedContracts = [...outstanding].sort((a, b) =>
    Number(b.direction === 'incoming') - Number(a.direction === 'incoming')
    || a.date_expired.localeCompare(b.date_expired))
  const contractValue = outstanding.reduce((s, c) => s + (c.price ?? c.reward ?? 0), 0)
  const pollMinutes = report?.last_poll ? minutesSince(report.last_poll) : null

  const notices: Notice[] = [
    ...dens.filter(d => d.reinforced_until).map(d => ({
      key: `den-${d.id}`, severity: 'danger' as const,
      what: `${d.type_name ?? 'Mercenary den'} is reinforced`,
      where: `${d.planet_name ?? 'Unknown planet'}, comes out in ${until(d.reinforced_until!)}`,
      act: 'Open dens', href: '/v2/mercenary',
    })),
    ...(report && pollMinutes != null && marketStale(report.last_poll, report.next_poll) ? [{
      key: 'poll', severity: 'warn' as const,
      what: 'Market data is out of date',
      where: `Last updated ${agoText(pollMinutes)}, stock figures may be wrong`,
      act: 'Check status', href: '/v2/settings',
    }] : []),
    ...incoming.map(c => ({
      key: `contract-${c.contract_id}`, severity: 'warn' as const,
      what: `Contract from ${c.issuer_name ?? 'an unknown pilot'} is waiting on you`,
      where: `Worth ${isk(c.price ?? c.reward)} ISK`,
      act: 'Review', href: '/v2/contracts',
    })),
    ...undercut.map(l => ({
      key: `listing-${l.order_id}`, severity: 'warn' as const,
      what: `Your ${l.item_name} order was undercut`,
      where: `Listed at ${isk(l.list_price)} in ${l.location_name}, lowest is now ${isk(l.market_low)}`,
      act: 'Reprice', href: '/v2/market-orders',
    })),
    ...(deliverable.length > 0 ? [{
      key: 'jobs-ready', severity: 'warn' as const,
      what: `${deliverable.length} industry job${deliverable.length === 1 ? ' is' : 's are'} ready to deliver`,
      where: groupNames(deliverable.map(j => j.product_name ?? j.blueprint_name ?? 'Job')),
      act: 'View jobs', href: '/v2/industry/jobs',
    }] : []),
    ...dens.filter(d => !d.reinforced_until && anarchyTier(d.anarchy_level, d.anarchy_amount) === 'red').map(d => ({
      key: `anarchy-${d.id}`, severity: 'warn' as const,
      what: `Anarchy is high at ${d.type_name ?? 'a den'}`,
      where: d.planet_name ?? '',
      act: 'Open dens', href: '/v2/mercenary',
    })),
  ].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'danger' ? -1 : 1))

  const sortedDens = [...dens].sort((a, b) => {
    const score = (d: Den) => (d.reinforced_until ? 3 : d.active_operation ? 2 : anarchyTier(d.anarchy_level, d.anarchy_amount) !== 'green' ? 1 : 0)
    return score(b) - score(a)
  })

  return (
    <div className="v2-dash">
      <div className="v2-top three">
        <section className="v2-panel" aria-labelledby="wallet-title">
          <div className="v2-panel-head">
            <h2 id="wallet-title">Wallet</h2>
            <Link href="/v2/settings?tab=characters">Choose wallets</Link>
          </div>
          {!wallet ? (
            <p className="v2-ledger-caption">Loading balances…</p>
          ) : !wallet.configured ? (
            <p className="v2-calm">
              No wallets chosen yet. <Link href="/v2/settings?tab=characters" style={{ color: 'var(--brass)' }}>Pick characters and corp divisions</Link> to see your total here.
            </p>
          ) : (
            <>
              <div className="v2-ledger-summary">
                <div className="v2-ledger-figure">{isk(wallet.total)}</div>
                <p className="v2-ledger-caption">
                  {wallet.change != null && (
                    <span className={wallet.change >= 0 ? 'up' : 'down'}>{wallet.change >= 0 ? '+' : '−'}{isk(Math.abs(wallet.change))} over 30 days</span>
                  )}
                  {wallet.change != null && ', '}
                  across {wallet.wallets.length} wallet{wallet.wallets.length === 1 ? '' : 's'}
                </p>
              </div>
              {wallet.series.length > 1 && <WalletChart series={wallet.series} />}
              {wallet.wallets.length > 1 && (
                <ul className="v2-rows compact">
                  {wallet.wallets.slice(0, 5).map(w => (
                    <li key={w.source}>
                      <span>{w.label}</span>
                      <span className="side">
                        <span className="val">{isk(w.balance)}</span>
                        {w.error && <span className="orange" title={w.error}>Not updating</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {wallet.wallets.length === 1 && wallet.wallets[0].error && (
                <p className="warn-text small">{wallet.wallets[0].label} isn&apos;t updating: {wallet.wallets[0].error}</p>
              )}
            </>
          )}
        </section>

        <section className="v2-panel v2-ledger" aria-labelledby="ledger-title">
          <div className="v2-panel-head">
            <h2 id="ledger-title">Ledger</h2>
            <Link href="/pnl">Full history</Link>
          </div>
          {pnl && pnl.daily.length > 0 ? (
            <>
              <div className="v2-ledger-summary">
                <div className={`v2-ledger-figure ${pnl.summary.total_profit >= 0 ? 'up' : 'down'}`}>
                  {pnl.summary.total_profit >= 0 ? '+' : '−'}{isk(Math.abs(pnl.summary.total_profit))}
                </div>
                <p className="v2-ledger-caption">
                  Profit over the last 30 days, a {pnl.summary.roi_pct.toFixed(1)}% return on cost
                </p>
              </div>
              {pnl.daily.length > 1 && <ProfitChart daily={pnl.daily} />}
            </>
          ) : (
            <p className="v2-calm">No sales recorded in the last 30 days.</p>
          )}
        </section>

        <section className="v2-panel" aria-labelledby="status-title">
          <h2 id="status-title">Status</h2>
          {notices.length === 0 ? (
            <p className="v2-calm">All clear. No contracts, orders, jobs or dens need you.</p>
          ) : (
            <ul className="v2-todo">
              {notices.slice(0, 6).map(n => (
                <li key={n.key} className={n.severity}>
                  <Link href={n.href}>
                    <span className="dot" aria-hidden />
                    <span>
                      <span className="what">{n.what}</span>
                      {n.where && <span className="where">{n.where}</span>}
                    </span>
                    <span className="act">{n.act}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {notices.length > 6 && <p className="v2-ledger-caption" style={{ marginTop: 10 }}>And {notices.length - 6} more.</p>}
        </section>

      </div>

      <div>
        {failed && !report ? (
          <p className="v2-calm">The dashboard couldn&apos;t reach the server. Check that the backend is running, then reload.</p>
        ) : !report ? (
          <div className="v2-skeleton" aria-busy="true" />
        ) : (
          <DoctrineBoard report={report} />
        )}
      </div>

      <div className="v2-side">
        <section className="v2-panel" aria-labelledby="orders-title">
          <div className="v2-panel-head">
            <h2 id="orders-title">Market orders</h2>
            <Link href="/v2/market-orders">All orders</Link>
          </div>
          <p className="v2-panel-sum">
            {listings.length} order{listings.length === 1 ? '' : 's'} worth {isk(listedValue)} ISK
            {undercut.length > 0 && <>, <span className="bad">{undercut.length} undercut</span></>}
          </p>
          {sortedListings.length === 0 ? (
            <p className="v2-empty">No sell orders. Orders you place in game show up here after the next sync.</p>
          ) : (
            <ul className="v2-rows">
              {sortedListings.slice(0, 6).map(l => (
                <li key={l.order_id}>
                  <span>
                    {l.item_name}
                    <span className="sub">{l.qty_remaining.toLocaleString()} of {l.qty_total.toLocaleString()} left in {l.location_name}</span>
                  </span>
                  <span className="side">
                    <span className="val">{isk(l.list_price)}</span>
                    {l.is_undercut
                      ? <span className="red">Undercut, lowest {isk(l.market_low)}</span>
                      : l.hours_remaining != null && l.hours_remaining < 24
                        ? <span className="orange">Expires in {Math.max(0, Math.round(l.hours_remaining))}h</span>
                        : <span>Lowest on market</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="v2-panel" aria-labelledby="contracts-title">
          <div className="v2-panel-head">
            <h2 id="contracts-title">Contracts</h2>
            <Link href="/v2/contracts">All contracts</Link>
          </div>
          <p className="v2-panel-sum">
            {outstanding.length} open, worth {isk(contractValue)} ISK
            {incoming.length > 0 && <>, <span className="warn">{incoming.length} waiting on you</span></>}
          </p>
          {sortedContracts.length === 0 ? (
            <p className="v2-empty">No open contracts.</p>
          ) : (
            <ul className="v2-rows">
              {sortedContracts.slice(0, 6).map(c => (
                <li key={c.contract_id}>
                  <span>
                    {c.title || CONTRACT_TYPE[c.type] || 'Contract'}
                    <span className="sub">
                      {c.direction === 'incoming'
                        ? `From ${c.issuer_name ?? 'unknown pilot'}`
                        : `To ${c.assignee_name ?? 'public'}`}
                      {c.title ? `, ${(CONTRACT_TYPE[c.type] ?? c.type).toLowerCase()}` : ''}
                    </span>
                  </span>
                  <span className="side">
                    <span className="val">{isk(c.price ?? c.reward)}</span>
                    <span className={c.direction === 'incoming' ? 'orange' : undefined}>
                      {c.direction === 'incoming' ? 'Waiting on you' : `Expires in ${until(c.date_expired)}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="v2-panel" aria-labelledby="jobs-title">
          <div className="v2-panel-head">
            <h2 id="jobs-title">Industry</h2>
            <Link href="/v2/industry/jobs">All jobs</Link>
          </div>
          {running.length === 0 ? (
            <p className="v2-empty">No jobs running. Start one in game and it shows up here after the next sync.</p>
          ) : (
            <ul className="v2-jobs">
              {running.slice(0, 6).map(j => {
                const start = new Date(j.start_date).getTime()
                const end = new Date(j.end_date).getTime()
                const progress = end > start ? Math.min(1, Math.max(0, (Date.now() - start) / (end - start))) : 1
                const eta = until(j.end_date)
                return (
                  <li key={j.id}>
                    <span className="name">
                      {j.product_name ?? j.blueprint_name ?? 'Job'}
                      {j.runs && j.runs > 1 ? <span style={{ color: 'var(--dust)' }}> ×{j.runs}</span> : null}
                    </span>
                    <span className={`eta${eta === 'done' ? ' done' : ''}`}>{eta === 'done' ? 'Ready' : eta}</span>
                    <span className="track" aria-hidden><i style={{ width: `${progress * 100}%` }} /></span>
                  </li>
                )
              })}
            </ul>
          )}
          {running.length > 6 && <p className="v2-ledger-caption" style={{ marginTop: 8 }}>{running.length - 6} more running.</p>}
        </section>

        <section className="v2-panel" aria-labelledby="dens-title">
          <div className="v2-panel-head">
            <h2 id="dens-title">Mercenary dens</h2>
            <Link href="/v2/mercenary">All dens</Link>
          </div>
          {sortedDens.length === 0 ? (
            <p className="v2-empty">No dens tracked yet.</p>
          ) : (
            <ul className="v2-rows">
              {sortedDens.slice(0, 6).map(d => {
                const tier = anarchyTier(d.anarchy_level, d.anarchy_amount)
                const [cls, label] = d.reinforced_until
                  ? ['red', `Reinforced, ${until(d.reinforced_until)} left`]
                  : d.active_operation
                    ? ['op', 'Operation running']
                    : tier === 'green'
                      ? ['', `Calm, development ${d.development_level.replace('Level', '')}`]
                      : [tier, tier === 'yellow' ? 'Anarchy rising' : 'Anarchy high']
                return (
                  <li key={d.id}>
                    <span>
                      {d.type_name ?? 'Den'}
                      <span className="sub">{d.planet_name}</span>
                    </span>
                    <span className={`side ${cls}`}>{label}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
