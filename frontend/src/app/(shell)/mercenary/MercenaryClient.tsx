'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTopbarActions } from '@/lib/topbar-context'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MercenaryDen {
  id: number
  den_id: number
  character_id: number
  character_name: string | null
  planet_id: number
  planet_name: string | null
  type_id: number
  type_name: string | null
  state: string
  development_level: string
  development_amount: number
  anarchy_level: string
  anarchy_amount: number
  infomorphs: number
  reinforced_until: string | null
  skyhook_planet_id: number | null
  skyhook_planet_name: string | null
  skyhook_corporation_id: number | null
  skyhook_corporation_name: string | null
  last_synced: string
}

interface MercenaryOperation {
  id: number
  operation_id: string
  character_id: number
  character_name: string | null
  den_id: number
  den_planet_id: number | null
  dungeon_type_id: number
  dungeon_name: string | null
  state: string
  expires: string
  last_synced: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

const DEN_STATE_COLORS: Record<string, string> = {
  Running:  'text-eve-green border-eve-green/40 bg-eve-green/10',
  Paused:   'text-eve-amber border-eve-amber/40 bg-eve-amber/10',
  Disabled: 'text-faint border-wire bg-surface',
}

const MTO_STATE_COLORS: Record<string, string> = {
  Available: 'text-accent border-accent/40 bg-accent/10',
  Started:   'text-eve-green border-eve-green/40 bg-eve-green/10',
  Completed: 'text-faint border-wire bg-surface',
  Expired:   'text-eve-red border-eve-red/40 bg-eve-red/10',
  Removed:   'text-faint border-wire bg-surface',
}

const TD = 'px-3 py-2 align-middle'
const TH = 'px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider whitespace-nowrap text-left'

function Meter({ label, level, amount }: { label: string; level: string; amount: number }) {
  return (
    <div className="min-w-[120px]">
      <div className="flex items-center justify-between text-[10px] text-muted mb-0.5">
        <span>{label}</span>
        <span>{level.replace('Level', 'L')} · {amount}/100</span>
      </div>
      <div className="h-1.5 rounded-full bg-wire overflow-hidden">
        <div className="h-full bg-accent" style={{ width: `${amount}%` }} />
      </div>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MercenaryClient() {
  const [dens, setDens] = useState<MercenaryDen[]>([])
  const [operations, setOperations] = useState<MercenaryOperation[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const { setActions } = useTopbarActions()

  const load = useCallback(async () => {
    try {
      const [densRes, opsRes] = await Promise.all([
        fetch('/api/mercenary/dens'),
        fetch('/api/mercenary/operations'),
      ])
      if (!densRes.ok || !opsRes.ok) throw new Error()
      setDens(await densRes.json())
      setOperations(await opsRes.json())
    } catch {
      setLoadError('Failed to load mercenary den data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const syncNow = useCallback(async () => {
    setSyncing(true); setSyncError(null)
    try {
      const r = await fetch('/api/mercenary/sync', { method: 'POST' })
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

  if (loading)   return <p className="text-muted text-[13px] p-6">Loading…</p>
  if (loadError) return <p className="text-eve-red text-[13px] p-6">{loadError}</p>

  return (
    <div className="space-y-6">
      {syncError && <p className="text-[12px] text-eve-red">{syncError}</p>}

      <div className="space-y-2">
        <h2 className="text-[13px] text-primary font-medium">Dens</h2>
        {dens.length === 0 ? (
          <p className="text-faint text-[13px] py-8 text-center">
            No mercenary dens found. Sync to fetch from ESI, or re-authenticate to add the required scopes.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {dens.map(d => (
              <div key={d.id} className="border border-wire rounded p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-primary truncate" title={d.type_name ?? undefined}>
                    {d.type_name ?? `Type ${d.type_id}`}
                  </span>
                  <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${DEN_STATE_COLORS[d.state] ?? 'text-faint border-wire'}`}>
                    {d.state}
                  </span>
                </div>
                <div className="text-[11px] text-muted truncate">
                  {d.character_name} · {d.planet_name ?? `Planet ${d.planet_id}`}
                </div>
                <Meter label="Development" level={d.development_level} amount={d.development_amount} />
                <Meter label="Anarchy" level={d.anarchy_level} amount={d.anarchy_amount} />
                <div className="text-[11px] text-muted">
                  Infomorphs: <span className="text-secondary font-mono">{d.infomorphs}</span>
                </div>
                {d.reinforced_until && (
                  <div className="text-[11px] text-eve-red">
                    Reinforced — {fmtRemaining(d.reinforced_until)} left
                  </div>
                )}
                <div className="text-[11px] text-faint truncate" title={d.skyhook_corporation_name ?? undefined}>
                  Contesting: {d.skyhook_corporation_name ?? (d.skyhook_corporation_id ?? '—')} skyhook on{' '}
                  {d.skyhook_planet_name ?? (d.skyhook_planet_id ? `planet ${d.skyhook_planet_id}` : '—')}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-[13px] text-primary font-medium">Tactical Operations</h2>
        {operations.length === 0 ? (
          <p className="text-faint text-[13px] py-8 text-center">No active or recent Mercenary Tactical Operations.</p>
        ) : (
          <div className="border border-wire rounded overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="bg-surface-hi border-b border-wire">
                <tr>
                  <th className={TH}>Character</th>
                  <th className={TH}>Den</th>
                  <th className={TH}>Site</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-wire">
                {operations.map(op => {
                  const isLive = op.state === 'Available' || op.state === 'Started'
                  return (
                    <tr key={op.id} className="hover:bg-surface/50">
                      <td className={`${TD} text-secondary`}>{op.character_name}</td>
                      <td className={`${TD} text-muted`}>
                        {op.den_planet_id ? `Planet ${op.den_planet_id}` : `Den ${op.den_id}`}
                      </td>
                      <td className={`${TD} text-primary`}>{op.dungeon_name ?? `Type ${op.dungeon_type_id}`}</td>
                      <td className={TD}>
                        <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${MTO_STATE_COLORS[op.state] ?? 'text-faint border-wire'}`}>
                          {op.state}
                        </span>
                      </td>
                      <td className={`${TD} font-mono whitespace-nowrap ${isLive ? 'text-secondary' : 'text-faint'}`}>
                        {isLive ? fmtRemaining(op.expires) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
