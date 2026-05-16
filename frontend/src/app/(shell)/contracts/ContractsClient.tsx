'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTopbarActions } from '@/lib/topbar-context'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Contract {
  id: number
  contract_id: number
  type: string
  status: string
  title: string | null
  direction: 'outgoing' | 'incoming'
  issuer_id: number
  issuer_name: string | null
  assignee_id: number | null
  assignee_name: string | null
  for_corporation: boolean
  availability: string
  price: number | null
  reward: number | null
  collateral: number | null
  volume: number | null
  date_issued: string
  date_expired: string
  date_accepted: string | null
  date_completed: string | null
  days_to_complete: number | null
  start_location_name: string | null
  end_location_name: string | null
  last_synced: string
}

type DirectionFilter = 'all' | 'outgoing' | 'incoming'
type StatusFilter    = 'all' | 'active' | 'finished' | 'cancelled'
type TypeFilter      = 'all' | 'courier' | 'item_exchange' | 'auction' | 'loan'
type SortKey = 'type' | 'status' | 'title' | 'direction' | 'issuer' | 'value' | 'collateral' | 'volume' | 'issued' | 'expires'

// ── Helpers ───────────────────────────────────────────────────────────────────

function iska(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}b`
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)}m`
  if (n >= 1_000)         return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function fmtVol(m3: number | null | undefined): string {
  if (m3 == null) return '—'
  if (m3 >= 1_000_000) return `${(m3 / 1_000_000).toFixed(1)}M m³`
  if (m3 >= 1_000)     return `${(m3 / 1_000).toFixed(1)}k m³`
  return `${m3.toLocaleString(undefined, { maximumFractionDigits: 0 })} m³`
}

function fmtExpiry(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now()
  if (diffMs < 0) return 'Expired'
  const days  = Math.floor(diffMs / 86_400_000)
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h`
  return '<1h'
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

const TYPE_LABELS: Record<string, string> = {
  courier:       'Courier',
  item_exchange: 'Item Exch.',
  auction:       'Auction',
  loan:          'Loan',
  unknown:       'Unknown',
}

const TYPE_COLORS: Record<string, string> = {
  courier:       'text-sky-400 border-sky-400/40 bg-sky-400/10',
  item_exchange: 'text-eve-green border-eve-green/40 bg-eve-green/10',
  auction:       'text-eve-amber border-eve-amber/40 bg-eve-amber/10',
  loan:          'text-faint border-wire bg-surface',
  unknown:       'text-faint border-wire bg-surface',
}

const STATUS_COLORS: Record<string, string> = {
  outstanding:         'text-accent border-accent/40 bg-accent/10',
  in_progress:         'text-eve-amber border-eve-amber/40 bg-eve-amber/10',
  finished:            'text-eve-green border-eve-green/40 bg-eve-green/10',
  finished_issuer:     'text-eve-green border-eve-green/40 bg-eve-green/10',
  finished_contractor: 'text-eve-green border-eve-green/40 bg-eve-green/10',
  cancelled:           'text-faint border-wire bg-surface',
  rejected:            'text-eve-red border-eve-red/40 bg-eve-red/10',
  failed:              'text-eve-red border-eve-red/40 bg-eve-red/10',
  deleted:             'text-faint border-wire bg-surface',
  reversed:            'text-faint border-wire bg-surface',
}

const STATUS_GROUPS: Record<StatusFilter, string[]> = {
  all:       [],
  active:    ['outstanding', 'in_progress'],
  finished:  ['finished', 'finished_issuer', 'finished_contractor'],
  cancelled: ['cancelled', 'rejected', 'failed', 'deleted', 'reversed'],
}

function statusLabel(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function contractPrimaryValue(c: Contract): number | null {
  return c.type === 'courier' ? c.reward : c.price
}

function routeLabel(c: Contract): string {
  if (c.type === 'courier') {
    return `${c.start_location_name ?? '?'} → ${c.end_location_name ?? '?'}`
  }
  return c.start_location_name ?? '—'
}

function sortValue(c: Contract, key: SortKey): string | number {
  switch (key) {
    case 'type':       return c.type
    case 'status':     return c.status
    case 'title':      return c.title ?? ''
    case 'direction':  return c.direction
    case 'issuer':     return c.issuer_name ?? String(c.issuer_id)
    case 'value':      return contractPrimaryValue(c) ?? -1
    case 'collateral': return c.collateral ?? -1
    case 'volume':     return c.volume ?? -1
    case 'issued':     return c.date_issued
    case 'expires':    return c.date_expired
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FilterBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-[12px] rounded border transition-colors capitalize ${
        active
          ? 'border-accent text-accent bg-accent/10'
          : 'border-wire text-muted hover:border-secondary hover:text-primary'
      }`}
    >
      {children}
    </button>
  )
}

function SortTh({
  label, sortKey, current, dir, onSort,
}: {
  label: string; sortKey: SortKey; current: SortKey; dir: 'asc' | 'desc'; onSort: (k: SortKey) => void
}) {
  const active = current === sortKey
  return (
    <th
      onClick={() => onSort(sortKey)}
      className="px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider whitespace-nowrap text-left cursor-pointer select-none hover:text-primary group"
    >
      {label}
      <span className={`ml-1 ${active ? 'text-accent' : 'text-wire group-hover:text-faint'}`}>
        {active ? (dir === 'asc' ? '▲' : '▼') : '▲'}
      </span>
    </th>
  )
}

const TD = 'px-3 py-2 align-middle'

// ── Component ─────────────────────────────────────────────────────────────────

export function ContractsClient() {
  const [contracts, setContracts]     = useState<Contract[]>([])
  const [loading, setLoading]         = useState(true)
  const [loadError, setLoadError]     = useState<string | null>(null)
  const [syncError, setSyncError]     = useState<string | null>(null)
  const [syncing, setSyncing]         = useState(false)
  const [dirFilter, setDirFilter]     = useState<DirectionFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [typeFilter, setTypeFilter]   = useState<TypeFilter>('all')
  const [sortKey, setSortKey]         = useState<SortKey>('expires')
  const [sortDir, setSortDir]         = useState<'asc' | 'desc'>('asc')

  const { setActions } = useTopbarActions()

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/contracts')
      if (!r.ok) throw new Error()
      setContracts(await r.json())
    } catch {
      setLoadError('Failed to load contracts.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const syncNow = useCallback(async () => {
    setSyncing(true); setSyncError(null)
    try {
      const r = await fetch('/api/contracts/sync', { method: 'POST' })
      if (!r.ok) throw new Error()
      await load()
    } catch {
      setSyncError('Sync failed — check Docker logs for details.')
      setTimeout(() => setSyncError(null), 10000)
    } finally {
      setSyncing(false)
    }
  }, [load])

  useEffect(() => {
    setActions(
      <button
        onClick={syncNow}
        disabled={syncing}
        className="px-3 py-1 text-[12px] border border-accent text-accent hover:bg-accent hover:text-canvas rounded transition-colors disabled:opacity-40 disabled:pointer-events-none"
      >
        {syncing ? 'Syncing…' : 'Sync Now'}
      </button>
    )
    return () => setActions(null)
  }, [setActions, syncing, syncNow])

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const visible = useMemo(() => {
    let list = contracts

    if (dirFilter !== 'all')
      list = list.filter(c => c.direction === dirFilter)

    if (statusFilter !== 'all')
      list = list.filter(c => STATUS_GROUPS[statusFilter].includes(c.status))

    if (typeFilter !== 'all')
      list = list.filter(c => c.type === typeFilter)

    list = [...list].sort((a, b) => {
      const av = sortValue(a, sortKey)
      const bv = sortValue(b, sortKey)
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })

    return list
  }, [contracts, dirFilter, statusFilter, typeFilter, sortKey, sortDir])

  if (loading)   return <p className="text-muted text-[13px] p-6">Loading…</p>
  if (loadError) return <p className="text-eve-red text-[13px] p-6">{loadError}</p>

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex gap-1">
          {(['all', 'outgoing', 'incoming'] as DirectionFilter[]).map(f => (
            <FilterBtn key={f} active={dirFilter === f} onClick={() => setDirFilter(f)}>{f}</FilterBtn>
          ))}
        </div>
        <div className="flex gap-1">
          {(['all', 'active', 'finished', 'cancelled'] as StatusFilter[]).map(f => (
            <FilterBtn key={f} active={statusFilter === f} onClick={() => setStatusFilter(f)}>{f}</FilterBtn>
          ))}
        </div>
        <div className="flex gap-1">
          <FilterBtn active={typeFilter === 'all'} onClick={() => setTypeFilter('all')}>All types</FilterBtn>
          {(['courier', 'item_exchange', 'auction', 'loan'] as const).map(f => (
            <FilterBtn key={f} active={typeFilter === f} onClick={() => setTypeFilter(f)}>{TYPE_LABELS[f]}</FilterBtn>
          ))}
        </div>
        <span className="text-[12px] text-faint ml-auto">
          {visible.length} contract{visible.length !== 1 ? 's' : ''}
        </span>
        {syncError && <span className="text-eve-red text-[12px] font-medium">{syncError}</span>}
      </div>

      {visible.length === 0 ? (
        <p className="text-faint text-[13px] py-8 text-center">
          {contracts.length === 0
            ? 'No contracts found. Sync to fetch from ESI, or re-authenticate to add contract scopes.'
            : 'No contracts match the current filters.'}
        </p>
      ) : (
        <div className="rounded border border-wire overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-surface border-b border-wire">
              <tr>
                <SortTh label="Type"       sortKey="type"       current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Status"     sortKey="status"     current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Title"      sortKey="title"      current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Direction"  sortKey="direction"  current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Issuer"     sortKey="issuer"     current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Value"      sortKey="value"      current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Collateral" sortKey="collateral" current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Volume"     sortKey="volume"     current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Route / Location" sortKey="title" current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Issued"     sortKey="issued"     current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Expires"    sortKey="expires"    current={sortKey} dir={sortDir} onSort={handleSort} />
              </tr>
            </thead>
            <tbody className="divide-y divide-wire">
              {visible.map(c => {
                const primaryValue = contractPrimaryValue(c)
                const isActive = c.status === 'outstanding' || c.status === 'in_progress'
                const expiry = fmtExpiry(c.date_expired)

                return (
                  <tr key={c.id} className="hover:bg-surface/50">
                    <td className={TD}>
                      <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${TYPE_COLORS[c.type] ?? TYPE_COLORS.unknown}`}>
                        {TYPE_LABELS[c.type] ?? c.type}
                      </span>
                    </td>
                    <td className={TD}>
                      <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${STATUS_COLORS[c.status] ?? 'text-faint border-wire'}`}>
                        {statusLabel(c.status)}
                      </span>
                    </td>
                    <td className={`${TD} max-w-[180px]`}>
                      <span className="block truncate text-primary" title={c.title ?? undefined}>
                        {c.title || <span className="text-faint">—</span>}
                      </span>
                    </td>
                    <td className={TD}>
                      <span className={c.direction === 'outgoing' ? 'text-secondary' : 'text-sky-400'}>
                        {c.direction === 'outgoing' ? 'Out' : 'In'}
                      </span>
                    </td>
                    <td className={`${TD} text-muted max-w-[140px]`}>
                      <span className="block truncate" title={c.issuer_name ?? String(c.issuer_id)}>
                        {c.issuer_name ?? <span className="text-faint font-mono">{c.issuer_id}</span>}
                      </span>
                    </td>
                    <td className={`${TD} font-mono text-secondary whitespace-nowrap`}>
                      {primaryValue != null ? `${iska(primaryValue)} ISK` : '—'}
                    </td>
                    <td className={`${TD} font-mono text-muted whitespace-nowrap`}>
                      {c.collateral != null ? `${iska(c.collateral)} ISK` : '—'}
                    </td>
                    <td className={`${TD} font-mono text-muted whitespace-nowrap`}>
                      {fmtVol(c.volume)}
                    </td>
                    <td className={`${TD} max-w-[200px]`}>
                      <span className="block truncate text-[11px] text-muted" title={routeLabel(c)}>
                        {routeLabel(c)}
                      </span>
                    </td>
                    <td className={`${TD} text-faint whitespace-nowrap`}>
                      {fmtDate(c.date_issued)}
                    </td>
                    <td className={`${TD} font-mono whitespace-nowrap ${
                      isActive ? (expiry === 'Expired' ? 'text-eve-red' : 'text-secondary') : 'text-faint'
                    }`}>
                      {expiry}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
