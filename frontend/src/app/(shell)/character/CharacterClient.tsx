'use client'

import { useState, useEffect, useCallback } from 'react'
import { ProgressBar } from '@/components/ProgressBar'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SlotBucket {
  in_use: number
  total: number | null
}

interface Overview {
  wallet_balance: number
  system_name: string | null
  location_name: string | null
  ship_type_id: number | null
  ship_name: string | null
  implants: { type_id: number; name: string | null }[]
  slots: {
    manufacturing: SlotBucket
    reactions: SlotBucket
    science: SlotBucket
  }
  missing_scopes: string[]
}

interface Training {
  skill_id: number
  skill_name: string | null
  finished_level: number
  start_date: string
  finish_date: string
  progress_pct: number
}

interface SkillsData {
  training: Training | null
  queue_length: number
  missing_scopes: string[]
}

interface Planet {
  planet_id: number
  system_name: string | null
  planet_type: string | null
  upgrade_level: number | null
  num_pins: number | null
  extractor_expiry_at: string | null
  extractors_idle: boolean
  storage_used_m3: number
  storage_capacity_m3: number | null
  storage_fill_pct: number | null
}

interface PlanetsData {
  planets: Planet[]
  missing_scopes: string[]
}

// ── Scope constants (must match backend/app/character/router.py) ──────────────

const SCOPE_LOCATION = 'esi-location.read_location.v1'
const SCOPE_SHIP = 'esi-location.read_ship_type.v1'
const SCOPE_IMPLANTS = 'esi-clones.read_implants.v1'
const SCOPE_SKILLS = 'esi-skills.read_skills.v1'
const SCOPE_SKILLQUEUE = 'esi-skills.read_skillqueue.v1'
const SCOPE_PLANETS = 'esi-planets.manage_planets.v1'

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

function Reconnect() {
  return <span className="text-faint italic">Reconnect to see this</span>
}

function slotBarColor(inUse: number, total: number | null): string {
  if (total == null || total === 0) return 'bg-accent'
  const pct = inUse / total
  if (pct >= 1) return 'bg-eve-red'
  if (pct >= 0.75) return 'bg-eve-amber'
  return 'bg-eve-green'
}

function storageBarColor(pct: number | null): string {
  if (pct == null) return 'bg-accent'
  if (pct >= 90) return 'bg-eve-red'
  if (pct >= 70) return 'bg-eve-amber'
  return 'bg-eve-green'
}

const SLOT_LABELS: Record<keyof Overview['slots'], string> = {
  manufacturing: 'Manufacturing',
  reactions: 'Reactions',
  science: 'Science',
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CharacterClient() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [skillsData, setSkillsData] = useState<SkillsData | null>(null)
  const [planetsData, setPlanetsData] = useState<PlanetsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [ovRes, skRes, plRes] = await Promise.all([
        fetch('/api/character/overview'),
        fetch('/api/character/skills'),
        fetch('/api/character/planets'),
      ])
      if (!ovRes.ok || !skRes.ok || !plRes.ok) throw new Error()
      setOverview(await ovRes.json())
      setSkillsData(await skRes.json())
      setPlanetsData(await plRes.json())
    } catch {
      setLoadError('Failed to load character data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading)   return <p className="text-muted text-[13px] p-6">Loading…</p>
  if (loadError) return <p className="text-eve-red text-[13px] p-6">{loadError}</p>
  if (!overview || !skillsData || !planetsData) return null

  const missing = new Set(overview.missing_scopes)
  const locationText = missing.has(SCOPE_LOCATION)
    ? null
    : overview.location_name
      ? `${overview.system_name ?? ''} · ${overview.location_name}`
      : overview.system_name
        ? `${overview.system_name} · in space`
        : '—'

  return (
    <div className="space-y-6">
      {/* Overview */}
      <div className="space-y-2">
        <h2 className="text-[13px] text-primary font-medium">Overview</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <div className="border border-wire rounded p-3 space-y-1">
            <div className="text-[10px] text-muted uppercase tracking-wider">Wallet</div>
            <div className="text-[15px] text-primary font-mono">{iska(overview.wallet_balance)} ISK</div>
            <div className="text-[11px] text-faint font-mono">{Math.round(overview.wallet_balance).toLocaleString()}</div>
          </div>

          <div className="border border-wire rounded p-3 space-y-1">
            <div className="text-[10px] text-muted uppercase tracking-wider">Location</div>
            <div className="text-[13px] text-primary">
              {locationText === null ? <Reconnect /> : locationText}
            </div>
          </div>

          <div className="border border-wire rounded p-3 space-y-1">
            <div className="text-[10px] text-muted uppercase tracking-wider">Active Ship</div>
            <div className="text-[13px] text-primary">
              {missing.has(SCOPE_SHIP) ? <Reconnect /> : (overview.ship_name ?? `Type ${overview.ship_type_id}`)}
            </div>
          </div>

          <div className="border border-wire rounded p-3 space-y-1">
            <div className="text-[10px] text-muted uppercase tracking-wider">Implants</div>
            {missing.has(SCOPE_IMPLANTS) ? (
              <Reconnect />
            ) : overview.implants.length === 0 ? (
              <div className="text-[13px] text-faint">None fitted</div>
            ) : (
              <ul className="text-[12px] text-secondary space-y-0.5">
                {overview.implants.map(i => (
                  <li key={i.type_id} className="truncate">{i.name ?? `Type ${i.type_id}`}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="border border-wire rounded p-3 space-y-2 xl:col-span-2">
            <div className="text-[10px] text-muted uppercase tracking-wider">Industry Slots</div>
            {missing.has(SCOPE_SKILLS) ? (
              <Reconnect />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {(Object.keys(overview.slots) as (keyof Overview['slots'])[]).map(key => {
                  const bucket = overview.slots[key]
                  return (
                    <ProgressBar
                      key={key}
                      label={SLOT_LABELS[key]}
                      pct={bucket.total ? (bucket.in_use / bucket.total) * 100 : 0}
                      sublabel={`${bucket.in_use} / ${bucket.total ?? '—'} slots`}
                      barColor={slotBarColor(bucket.in_use, bucket.total)}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Skills */}
      <div className="space-y-2">
        <h2 className="text-[13px] text-primary font-medium">Skill Training</h2>
        <div className="border border-wire rounded p-3">
          {missing.has(SCOPE_SKILLQUEUE) ? (
            <Reconnect />
          ) : !skillsData.training ? (
            <p className="text-faint text-[13px]">No skill currently training.</p>
          ) : (
            <div className="space-y-2 max-w-sm">
              <div className="text-[13px] text-primary">
                {skillsData.training.skill_name ?? `Skill ${skillsData.training.skill_id}`} {skillsData.training.finished_level}
              </div>
              <ProgressBar
                label="Progress"
                pct={skillsData.training.progress_pct}
                sublabel={`~${fmtRemaining(skillsData.training.finish_date)} remaining`}
              />
              <div className="text-[11px] text-faint">
                {skillsData.queue_length} skill{skillsData.queue_length === 1 ? '' : 's'} in queue
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Planets */}
      <div className="space-y-2">
        <h2 className="text-[13px] text-primary font-medium">Planetary Interaction</h2>
        {missing.has(SCOPE_PLANETS) ? (
          <div className="border border-wire rounded p-3"><Reconnect /></div>
        ) : planetsData.planets.length === 0 ? (
          <p className="text-faint text-[13px] py-8 text-center">No active planetary colonies.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {planetsData.planets.map(p => (
              <div key={p.planet_id} className="border border-wire rounded p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-primary truncate">
                    {p.system_name ?? `System ${p.planet_id}`}
                  </span>
                  <span className="text-[11px] text-muted capitalize">{p.planet_type}</span>
                </div>
                <div className="text-[11px] text-faint">{p.num_pins ?? 0} pins · upgrade level {p.upgrade_level ?? 0}</div>
                <div className="text-[11px]">
                  {p.extractor_expiry_at ? (
                    <span className={p.extractors_idle ? 'text-eve-red' : 'text-secondary'}>
                      {p.extractors_idle ? 'Extraction idle' : `Extraction ends in ${fmtRemaining(p.extractor_expiry_at)}`}
                    </span>
                  ) : (
                    <span className="text-faint">No active extractors</span>
                  )}
                </div>
                {p.storage_fill_pct != null && (
                  <ProgressBar
                    label="Storage"
                    pct={p.storage_fill_pct}
                    sublabel={`${p.storage_used_m3.toLocaleString()} / ${p.storage_capacity_m3?.toLocaleString()} m³`}
                    barColor={storageBarColor(p.storage_fill_pct)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
