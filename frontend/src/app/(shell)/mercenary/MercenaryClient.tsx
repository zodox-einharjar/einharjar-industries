'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTopbarActions } from '@/lib/topbar-context'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActiveOperation {
  state: string
  expires: string
  dungeon_type_id: number
  dungeon_name: string | null
}

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
  deployed_at: string | null
  development_level: string
  development_amount: number
  development_next_threshold: number
  development_next_level_at: string | null
  anarchy_level: string
  anarchy_amount: number
  anarchy_next_threshold: number
  anarchy_next_level_at: string | null
  infomorphs: number
  infomorphs_m3: number
  infomorphs_rate_min: number | null
  infomorphs_rate_max: number | null
  reinforced_until: string | null
  skyhook_planet_id: number | null
  skyhook_planet_name: string | null
  skyhook_corporation_id: number | null
  skyhook_corporation_name: string | null
  active_operation: ActiveOperation | null
  next_mto_estimate_at: string | null
  mto_locked: boolean
  mto_unlock_at: string | null
  last_synced: string
}

interface MercenaryOperation {
  id: number
  operation_id: string
  character_id: number
  character_name: string | null
  den_id: number
  den_planet_id: number | null
  den_planet_name: string | null
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

function fmtElapsed(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  if (diffMs <= 0) return '0m'
  const days  = Math.floor(diffMs / 86_400_000)
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000)
  const mins  = Math.floor((diffMs % 3_600_000) / 60_000)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

// EVE time is UTC — the deployment input is edited and displayed in EVE
// time, not the browser's local timezone.
function toEveInputValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function eveInputValueToIso(value: string): string {
  const [datePart, timePart] = value.split('T')
  const [y, m, d] = datePart.split('-').map(Number)
  const [hh, mm] = timePart.split(':').map(Number)
  return new Date(Date.UTC(y, m - 1, d, hh, mm)).toISOString()
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

// Cumulative floor for Level0-4 — a level's point span divided by 5 (points
// per 24h, confirmed fixed rate) gives its segment count, so each segment
// always represents exactly one day: 4 segments for Level0/1 (20 pts), 6 for
// Level2/3 (30 pts).
const LEVEL_CUM = [0, 20, 40, 70, 100]

function levelIndex(level: string): number {
  return parseInt(level.replace('Level', ''), 10) || 0
}

// Anarchy meter goes from green to yellow once it passes 15/20 within
// Level0 (also the point MTOs start spawning), orange for Level1, red from
// Level2 up — confirmed by the user, not documented by CCP.
function anarchyBarColor(level: string, amount: number): string {
  const idx = levelIndex(level)
  if (idx <= 0) return amount >= 15 ? 'bg-eve-yellow' : 'bg-eve-green'
  if (idx === 1) return 'bg-eve-amber'
  return 'bg-eve-red'
}

function Meter({
  label, level, amount, nextThreshold, nextLevelAt, barColor = 'bg-accent',
}: {
  label: string
  level: string
  amount: number
  nextThreshold: number
  nextLevelAt: string | null
  barColor?: string
}) {
  const idx = levelIndex(level)
  const levelStart = LEVEL_CUM[idx] ?? nextThreshold
  const levelSpan = Math.max(0, nextThreshold - levelStart)
  const segmentCount = levelSpan > 0 ? Math.round(levelSpan / 5) : 1
  const progress = Math.max(0, Math.min(levelSpan, amount - levelStart))

  return (
    <div className="min-w-[120px]">
      <div className="flex items-center justify-between text-[10px] text-muted mb-0.5">
        <span>{label}</span>
        <span>{level.replace('Level', 'L')} · {progress}/{levelSpan}</span>
      </div>
      <div className="flex h-1.5 rounded-full overflow-hidden gap-px">
        {Array.from({ length: segmentCount }).map((_, i) => {
          const fillPct = levelSpan > 0
            ? Math.max(0, Math.min(1, (progress - i * 5) / 5)) * 100
            : 100
          return (
            <div key={i} className="flex-1 bg-wire">
              <div className={`h-full ${barColor}`} style={{ width: `${fillPct}%` }} />
            </div>
          )
        })}
      </div>
      <div className="text-[10px] text-faint mt-0.5">
        {amount >= 100 ? 'maxed' : nextLevelAt ? `~${fmtRemaining(nextLevelAt)} to next level` : ''}
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
  const [syncMessage, setSyncMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [editingDeployId, setEditingDeployId] = useState<number | null>(null)
  const [deployValue, setDeployValue] = useState('')
  const [deploySaving, setDeploySaving] = useState(false)

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
    setSyncing(true); setSyncMessage(null)
    try {
      const r = await fetch('/api/mercenary/sync', { method: 'POST' })
      if (!r.ok) throw new Error()
      await load()
      setSyncMessage({ text: 'Synced', ok: true })
    } catch {
      setSyncMessage({ text: 'Sync failed — check Docker logs for details.', ok: false })
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMessage(null), 4000)
    }
  }, [load])

  const startEditDeploy = useCallback((den: MercenaryDen) => {
    setEditingDeployId(den.id)
    setDeployValue(toEveInputValue(den.deployed_at ?? new Date().toISOString()))
  }, [])

  const cancelEditDeploy = useCallback(() => setEditingDeployId(null), [])

  const submitDeploy = useCallback(async (denId: number, value: string | null) => {
    setDeploySaving(true)
    try {
      const r = await fetch(`/api/mercenary/dens/${denId}/deployed-at`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deployed_at: value }),
      })
      if (!r.ok) throw new Error()
      await load()
      setEditingDeployId(null)
    } catch {
      setSyncError('Failed to update deployment time.')
      setTimeout(() => setSyncError(null), 10000)
    } finally {
      setDeploySaving(false)
    }
  }, [load])

  const saveDeploy = useCallback((denId: number) => {
    if (!deployValue) return
    submitDeploy(denId, eveInputValueToIso(deployValue))
  }, [deployValue, submitDeploy])

  const clearDeploy = useCallback((denId: number) => submitDeploy(denId, null), [submitDeploy])

  useEffect(() => {
    setActions(
      <div className="flex items-center gap-2">
        {syncMessage && (
          <span className={`text-[12px] ${syncMessage.ok ? 'text-eve-green' : 'text-eve-red'}`}>
            {syncMessage.text}
          </span>
        )}
        <button
          onClick={syncNow}
          disabled={syncing}
          className="px-3 py-1 text-[12px] border border-accent text-accent hover:bg-accent hover:text-canvas rounded transition-colors disabled:opacity-40 disabled:pointer-events-none"
        >
          {syncing ? 'Syncing…' : 'Sync Now'}
        </button>
      </div>
    )
    return () => setActions(null)
  }, [setActions, syncing, syncNow, syncMessage])

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
                <div className="text-[11px] text-faint flex items-center gap-2">
                  {d.deployed_at ? (
                    <>
                      <span>Deployed {fmtElapsed(d.deployed_at)} ago</span>
                      <button onClick={() => startEditDeploy(d)} className="text-faint hover:text-accent underline decoration-dotted">edit</button>
                    </>
                  ) : (
                    <button onClick={() => startEditDeploy(d)} className="text-accent hover:underline">Set deployment time</button>
                  )}
                </div>
                {editingDeployId === d.id && (
                  <div className="flex items-center gap-1 text-[11px]">
                    <input
                      type="datetime-local"
                      value={deployValue}
                      onChange={e => setDeployValue(e.target.value)}
                      className="bg-surface border border-wire rounded px-1 py-0.5 text-[11px] text-primary"
                    />
                    <span className="text-faint">EVE time</span>
                    <button
                      onClick={() => saveDeploy(d.id)}
                      disabled={deploySaving}
                      className="px-1.5 py-0.5 border border-accent text-accent rounded hover:bg-accent hover:text-canvas disabled:opacity-40"
                    >
                      Save
                    </button>
                    {d.deployed_at && (
                      <button
                        onClick={() => clearDeploy(d.id)}
                        disabled={deploySaving}
                        className="px-1.5 py-0.5 border border-wire text-faint rounded hover:text-eve-red hover:border-eve-red/40 disabled:opacity-40"
                      >
                        Clear
                      </button>
                    )}
                    <button onClick={cancelEditDeploy} className="px-1.5 py-0.5 text-faint hover:text-secondary">Cancel</button>
                  </div>
                )}
                <Meter label="Development" level={d.development_level} amount={d.development_amount} nextThreshold={d.development_next_threshold} nextLevelAt={d.development_next_level_at} />
                <Meter
                  label="Anarchy"
                  level={d.anarchy_level}
                  amount={d.anarchy_amount}
                  nextThreshold={d.anarchy_next_threshold}
                  nextLevelAt={d.anarchy_next_level_at}
                  barColor={anarchyBarColor(d.anarchy_level, d.anarchy_amount)}
                />
                <div className="text-[11px] text-muted">
                  Infomorphs: <span className="text-secondary font-mono">{d.infomorphs}</span>
                  {' '}<span className="text-faint font-mono">({d.infomorphs_m3.toLocaleString()} m³)</span>
                  {d.infomorphs_rate_min != null && (
                    <span className="text-faint"> ({d.infomorphs_rate_min}–{d.infomorphs_rate_max}/hr)</span>
                  )}
                </div>
                <div className="text-[11px]">
                  {d.active_operation ? (
                    <span className={d.active_operation.state === 'Started' ? 'text-eve-green' : 'text-accent'}>
                      MTO {d.active_operation.state.toLowerCase()} — {d.active_operation.dungeon_name ?? `Type ${d.active_operation.dungeon_type_id}`},
                      {' '}expires in {fmtRemaining(d.active_operation.expires)}
                    </span>
                  ) : d.mto_locked ? (
                    <span className="text-faint">
                      {d.mto_unlock_at ? `MTOs unlock in ~${fmtRemaining(d.mto_unlock_at)}` : 'MTOs unlock once Anarchy reaches 15/20'}
                    </span>
                  ) : d.next_mto_estimate_at ? (
                    <span className="text-faint">Next MTO (est.): ~{fmtRemaining(d.next_mto_estimate_at)}</span>
                  ) : (
                    <span className="text-faint">No active MTO — not enough history for an estimate yet</span>
                  )}
                </div>
                {d.reinforced_until && (
                  <div className="text-[11px] text-eve-red">
                    Reinforced — {fmtRemaining(d.reinforced_until)} left
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-[13px] text-primary font-medium">Mercenary Tactical Operations</h2>
        {operations.length === 0 ? (
          <p className="text-faint text-[13px] py-8">No active or recent Mercenary Tactical Operations.</p>
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
                        {op.den_planet_name ?? (op.den_planet_id ? `Planet ${op.den_planet_id}` : `Den ${op.den_id}`)}
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
