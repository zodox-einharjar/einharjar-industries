'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useTopbarActions } from '@/lib/topbar-context'

// ── Types ─────────────────────────────────────────────────────────────────────

interface IndustryJob {
  id: number
  job_id: number
  project_id: number | null
  project_name: string | null
  source: 'char' | 'corp'
  activity_id: number
  activity_name: string
  installer_id: number
  installer_name: string | null
  blueprint_type_id: number
  blueprint_name: string | null
  product_type_id: number | null
  product_name: string | null
  runs: number
  licensed_runs: number | null
  cost: number | null
  probability: number | null
  successful_runs: number | null
  status: string
  duration: number
  start_date: string
  end_date: string
  pause_date: string | null
  completed_date: string | null
  completed_character_id: number | null
  completed_character_name: string | null
  facility_name: string | null
  output_location_name: string | null
  last_synced: string
}

type StatusFilter   = 'all' | 'active' | 'history'
type ActivityFilter = 'all' | number
type SortKey = 'activity' | 'blueprint' | 'installer' | 'status' | 'runs' | 'cost' | 'ends'

// ── Helpers ───────────────────────────────────────────────────────────────────

function iska(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}b`
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)}m`
  if (n >= 1_000)         return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
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

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

const ACTIVITIES: { id: number; label: string }[] = [
  { id: 1, label: 'Manufacturing' },
  { id: 3, label: 'TE Research' },
  { id: 4, label: 'ME Research' },
  { id: 5, label: 'Copying' },
  { id: 7, label: 'Reverse Eng.' },
  { id: 8, label: 'Invention' },
  { id: 9, label: 'Reactions' },
]

const STATUS_COLORS: Record<string, string> = {
  active:    'text-accent border-accent/40 bg-accent/10',
  paused:    'text-eve-amber border-eve-amber/40 bg-eve-amber/10',
  ready:     'text-eve-amber border-eve-amber/40 bg-eve-amber/10',
  delivered: 'text-eve-green border-eve-green/40 bg-eve-green/10',
  cancelled: 'text-faint border-wire bg-surface',
  reverted:  'text-eve-red border-eve-red/40 bg-eve-red/10',
}

const STATUS_GROUPS: Record<StatusFilter, string[]> = {
  all:     [],
  active:  ['active', 'paused', 'ready'],
  history: ['delivered', 'cancelled', 'reverted'],
}

function statusLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function sortValue(j: IndustryJob, key: SortKey): string | number {
  switch (key) {
    case 'activity':  return j.activity_name
    case 'blueprint': return j.blueprint_name ?? String(j.blueprint_type_id)
    case 'installer': return j.installer_name ?? String(j.installer_id)
    case 'status':    return j.status
    case 'runs':      return j.runs
    case 'cost':      return j.cost ?? -1
    case 'ends':      return j.completed_date ?? j.end_date
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

export function JobsClient() {
  const [jobs, setJobs]               = useState<IndustryJob[]>([])
  const [loading, setLoading]         = useState(true)
  const [loadError, setLoadError]     = useState<string | null>(null)
  const [syncError, setSyncError]     = useState<string | null>(null)
  const [syncing, setSyncing]         = useState(false)
  const [statusFilter, setStatusFilter]     = useState<StatusFilter>('active')
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all')
  const [sortKey, setSortKey]         = useState<SortKey>('ends')
  const [sortDir, setSortDir]         = useState<'asc' | 'desc'>('asc')

  const { setActions } = useTopbarActions()

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/industry/jobs')
      if (!r.ok) throw new Error()
      setJobs(await r.json())
    } catch {
      setLoadError('Failed to load industry jobs.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const syncNow = useCallback(async () => {
    setSyncing(true); setSyncError(null)
    try {
      const r = await fetch('/api/industry/jobs/sync', { method: 'POST' })
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
    let list = jobs

    if (statusFilter !== 'all')
      list = list.filter(j => STATUS_GROUPS[statusFilter].includes(j.status))

    if (activityFilter !== 'all')
      list = list.filter(j => j.activity_id === activityFilter)

    list = [...list].sort((a, b) => {
      const av = sortValue(a, sortKey)
      const bv = sortValue(b, sortKey)
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })

    return list
  }, [jobs, statusFilter, activityFilter, sortKey, sortDir])

  if (loading)   return <p className="text-muted text-[13px] p-6">Loading…</p>
  if (loadError) return <p className="text-eve-red text-[13px] p-6">{loadError}</p>

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex gap-1">
          {(['all', 'active', 'history'] as StatusFilter[]).map(f => (
            <FilterBtn key={f} active={statusFilter === f} onClick={() => setStatusFilter(f)}>{f}</FilterBtn>
          ))}
        </div>
        <div className="flex gap-1">
          <FilterBtn active={activityFilter === 'all'} onClick={() => setActivityFilter('all')}>All activities</FilterBtn>
          {ACTIVITIES.map(a => (
            <FilterBtn key={a.id} active={activityFilter === a.id} onClick={() => setActivityFilter(a.id)}>{a.label}</FilterBtn>
          ))}
        </div>
        <span className="text-[12px] text-faint ml-auto">
          {visible.length} job{visible.length !== 1 ? 's' : ''}
        </span>
        {syncError && <span className="text-eve-red text-[12px] font-medium">{syncError}</span>}
      </div>

      {visible.length === 0 ? (
        <p className="text-faint text-[13px] py-8 text-center">
          {jobs.length === 0
            ? 'No industry jobs found. Sync to fetch from ESI, or re-authenticate to add industry scopes.'
            : 'No jobs match the current filters.'}
        </p>
      ) : (
        <div className="rounded border border-wire overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-surface border-b border-wire">
              <tr>
                <SortTh label="Activity"   sortKey="activity"   current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Blueprint / Product" sortKey="blueprint" current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Runs"       sortKey="runs"       current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Installer"  sortKey="installer"  current={sortKey} dir={sortDir} onSort={handleSort} />
                <th className="px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider whitespace-nowrap text-left">Facility</th>
                <SortTh label="Status"     sortKey="status"     current={sortKey} dir={sortDir} onSort={handleSort} />
                <SortTh label="Cost"       sortKey="cost"       current={sortKey} dir={sortDir} onSort={handleSort} />
                <th className="px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider whitespace-nowrap text-left">Started</th>
                <SortTh label="Ends / Completed" sortKey="ends" current={sortKey} dir={sortDir} onSort={handleSort} />
              </tr>
            </thead>
            <tbody className="divide-y divide-wire">
              {visible.map(j => {
                const isActive = j.status === 'active' || j.status === 'paused' || j.status === 'ready'
                const remaining = isActive ? fmtRemaining(j.end_date) : null

                return (
                  <tr key={j.id} className="hover:bg-surface/50">
                    <td className={TD}>
                      <span className="text-secondary">{j.activity_name}</span>
                      <span className="ml-1.5 text-[10px] text-faint uppercase">{j.source}</span>
                    </td>
                    <td className={`${TD} max-w-[220px]`}>
                      <span className="block truncate text-primary" title={j.blueprint_name ?? undefined}>
                        {j.blueprint_name ?? <span className="font-mono text-faint">{j.blueprint_type_id}</span>}
                      </span>
                      {j.product_name && j.product_name !== j.blueprint_name && (
                        <span className="block truncate text-[11px] text-muted" title={j.product_name}>
                          → {j.product_name}
                        </span>
                      )}
                      {j.project_id && (
                        <Link
                          href={`/industry/${j.project_id}`}
                          className="mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-accent/40 bg-accent/10 text-[10px] text-accent hover:bg-accent/20 truncate max-w-full"
                          title={`Linked to project: ${j.project_name}`}
                        >
                          {j.project_name}
                        </Link>
                      )}
                    </td>
                    <td className={`${TD} font-mono text-secondary whitespace-nowrap`}>
                      {j.runs.toLocaleString()}
                    </td>
                    <td className={`${TD} text-muted max-w-[140px]`}>
                      <span className="block truncate" title={j.installer_name ?? String(j.installer_id)}>
                        {j.installer_name ?? <span className="font-mono text-faint">{j.installer_id}</span>}
                      </span>
                    </td>
                    <td className={`${TD} text-muted max-w-[160px]`}>
                      <span className="block truncate" title={j.facility_name ?? undefined}>
                        {j.facility_name ?? <span className="text-faint">Unknown structure</span>}
                      </span>
                    </td>
                    <td className={TD}>
                      <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${STATUS_COLORS[j.status] ?? 'text-faint border-wire'}`}>
                        {statusLabel(j.status)}
                      </span>
                    </td>
                    <td className={`${TD} font-mono text-muted whitespace-nowrap`}>
                      {j.cost != null ? `${iska(j.cost)} ISK` : '—'}
                    </td>
                    <td className={`${TD} text-faint whitespace-nowrap`}>
                      {fmtDate(j.start_date)}
                    </td>
                    <td className={`${TD} font-mono whitespace-nowrap ${isActive ? 'text-secondary' : 'text-faint'}`}>
                      {isActive ? remaining : fmtDate(j.completed_date ?? j.end_date)}
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
