'use client'

import { useState, useEffect } from 'react'

const INTERVAL_OPTIONS = [
  { value: 5,  label: '5 minutes' },
  { value: 10, label: '10 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '60 minutes' },
]

function fmtEsiExpiry(iso: string | null | undefined): string {
  if (!iso) return 'not yet fetched'
  const d = new Date(iso)
  const now = new Date()
  const diffMs = d.getTime() - now.getTime()
  const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (diffMs <= 0) return `expired at ${timeStr} — sync may return fresh data`
  const diffMin = Math.ceil(diffMs / 60000)
  return `${timeStr} (in ${diffMin}m)`
}

function fmtSdeDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return (
    `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ` +
    `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
  )
}

type SdeStatus = {
  installed_at: string | null
  remote_last_modified: string | null
}

type SdeCheckResult = {
  remote_last_modified: string | null
  update_available: boolean | null
}

export function GeneralTab() {
  const [interval, setIntervalVal]   = useState<number>(5)
  const [esiExpires, setEsiExpires]  = useState<string | null>(null)
  const [loading, setLoading]        = useState(true)
  const [saving, setSaving]          = useState(false)
  const [saved, setSaved]            = useState(false)
  const [error, setError]            = useState<string | null>(null)

  const [sdeStatus, setSdeStatus]         = useState<SdeStatus | null>(null)
  const [sdeCheck, setSdeCheck]           = useState<SdeCheckResult | null>(null)
  const [sdeChecking, setSdeChecking]     = useState(false)
  const [sdeUpdating, setSdeUpdating]     = useState(false)
  const [sdeError, setSdeError]           = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      const [settingsRes, sdeRes] = await Promise.all([
        fetch('/api/settings'),
        fetch('/api/settings/sde-status'),
      ])
      if (!settingsRes.ok) throw new Error()
      const data = await settingsRes.json()
      setIntervalVal(data.poll_interval_minutes ?? 5)
      setEsiExpires(data.orders_esi_expires ?? null)
      if (sdeRes.ok) {
        setSdeStatus(await sdeRes.json())
      }
    } catch {
      setError('Failed to load settings.')
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    setSaving(true); setError(null)
    try {
      const r = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poll_interval_minutes: interval }),
      })
      if (!r.ok) throw new Error()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Failed to save settings.')
    } finally {
      setSaving(false)
    }
  }

  async function checkSde() {
    setSdeChecking(true); setSdeError(null)
    try {
      const r = await fetch('/api/settings/sde-check')
      if (!r.ok) throw new Error()
      setSdeCheck(await r.json())
    } catch {
      setSdeError('Failed to reach CCP SDE endpoint — check internet access from the container.')
    } finally {
      setSdeChecking(false)
    }
  }

  async function updateSde() {
    setSdeUpdating(true); setSdeError(null)
    try {
      const r = await fetch('/api/settings/update-sde', { method: 'POST' })
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        throw new Error(body.detail ?? 'Update failed')
      }
      setSdeCheck(null)
      const statusRes = await fetch('/api/settings/sde-status')
      if (statusRes.ok) setSdeStatus(await statusRes.json())
    } catch (e: unknown) {
      setSdeError(e instanceof Error ? e.message : 'SDE update failed.')
    } finally {
      setSdeUpdating(false)
    }
  }

  if (loading) return <p className="text-muted text-[13px]">Loading…</p>

  return (
    <div className="space-y-6">
      <div>
        <span className="text-[11px] font-semibold text-muted uppercase tracking-wider">Market Polling</span>
        <div className="mt-3 rounded border border-wire p-4 space-y-3">
          <div className="flex items-center gap-4">
            <label className="text-[13px] text-secondary w-40 flex-shrink-0">Poll interval</label>
            <select
              value={interval}
              onChange={e => setIntervalVal(Number(e.target.value))}
              className="bg-surface border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
            >
              {INTERVAL_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <p className="text-[11px] text-faint">
            How often to poll market orders for all configured locations. Changes take effect immediately.
          </p>
          <div className="flex items-start gap-4 pt-1">
            <span className="text-[13px] text-secondary w-40 flex-shrink-0">ESI cache expires</span>
            <span className="text-[12px] font-mono text-muted">{fmtEsiExpiry(esiExpires)}</span>
          </div>
          <p className="text-[11px] text-faint">
            ESI caches character orders server-side for up to 30 minutes. New orders placed in EVE
            won&apos;t appear in a sync until after the cache expires, regardless of poll interval.
          </p>
        </div>
      </div>

      <div>
        <span className="text-[11px] font-semibold text-muted uppercase tracking-wider">SDE (Static Data Export)</span>
        <div className="mt-3 rounded border border-wire p-4 space-y-3">
          <div className="flex items-center gap-4">
            <span className="text-[13px] text-secondary w-40 flex-shrink-0">Installed</span>
            <span className="text-[12px] font-mono text-muted">{fmtSdeDate(sdeStatus?.installed_at)}</span>
          </div>
          {sdeCheck && (
            <div className="flex items-center gap-4">
              <span className="text-[13px] text-secondary w-40 flex-shrink-0">Latest</span>
              <span className="text-[12px] font-mono text-muted">{fmtSdeDate(sdeCheck.remote_last_modified)}</span>
              {sdeCheck.update_available === true && (
                <span className="text-[11px] text-eve-yellow font-medium">⚠ Update available</span>
              )}
              {sdeCheck.update_available === false && (
                <span className="text-[11px] text-eve-green font-medium">✓ Up to date</span>
              )}
              {sdeCheck.update_available === null && (
                <span className="text-[11px] text-faint">Could not determine</span>
              )}
            </div>
          )}
          <p className="text-[11px] text-faint">
            Static game data (item names, volumes, station names) sourced from the official CCP SDE. Update after each EVE patch.
          </p>
          {sdeError && <p className="text-eve-red text-[12px]">{sdeError}</p>}
          <div className="flex gap-2">
            <button
              onClick={checkSde}
              disabled={sdeChecking || sdeUpdating}
              className="text-[13px] px-4 py-1.5 rounded border border-wire text-secondary hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
            >
              {sdeChecking ? 'Checking…' : 'Check for updates'}
            </button>
            <button
              onClick={updateSde}
              disabled={sdeUpdating || sdeChecking}
              className="text-[13px] px-4 py-1.5 rounded border border-accent text-accent hover:bg-accent hover:text-canvas transition-colors disabled:opacity-50"
            >
              {sdeUpdating ? 'Downloading…' : 'Update SDE'}
            </button>
          </div>
        </div>
      </div>

      {error && <p className="text-eve-red text-[12px]">{error}</p>}

      <button
        onClick={save}
        disabled={saving}
        className={`text-[13px] px-4 py-1.5 rounded border transition-colors ${
          saved
            ? 'border-eve-green text-eve-green'
            : 'border-accent text-accent hover:bg-accent hover:text-canvas'
        }`}
      >
        {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save Changes'}
      </button>
    </div>
  )
}
