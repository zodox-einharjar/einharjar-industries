'use client'

import { useState, useEffect, type FormEvent } from 'react'

interface Location {
  id: number
  name: string
  eve_id: number
  location_type: string
  region_id: number
  system_id: number | null
  broker_fee_pct: number
  sales_tax_pct: number
  scc_surcharge_pct: number
}

const INPUT = 'bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary placeholder:text-faint focus:outline-none focus:border-accent transition-colors'
const FEE_INPUT = 'bg-canvas border border-wire rounded px-2 py-1 text-[12px] font-mono text-primary focus:outline-none focus:border-accent transition-colors w-16 text-right'
const ID_INPUT  = 'bg-canvas border border-wire rounded px-2 py-1 text-[12px] font-mono text-primary focus:outline-none focus:border-accent transition-colors w-28 text-right'
const TH = 'text-left px-4 py-2.5 text-[11px] font-semibold text-muted uppercase tracking-wider whitespace-nowrap'

function FeeCell({ locId, field, value, onSaved }: {
  locId: number
  field: 'broker_fee_pct' | 'sales_tax_pct' | 'scc_surcharge_pct'
  value: number
  onSaved: (updated: Location) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(value))
  const [saving, setSaving] = useState(false)

  async function save() {
    const num = parseFloat(draft)
    if (isNaN(num) || num < 0 || num > 100) { setDraft(String(value)); setEditing(false); return }
    if (num === value) { setEditing(false); return }
    setSaving(true)
    try {
      const r = await fetch(`/api/locations/${locId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: num }),
      })
      if (r.ok) onSaved(await r.json())
    } finally {
      setSaving(false)
      setEditing(false)
    }
  }

  if (!editing) {
    return (
      <span
        onClick={() => { setDraft(String(value)); setEditing(true) }}
        className="font-mono text-[12px] text-secondary cursor-pointer hover:text-accent transition-colors"
        title="Click to edit"
      >
        {value}%
      </span>
    )
  }

  return (
    <input
      autoFocus
      type="number"
      step="0.1"
      min="0"
      max="100"
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setDraft(String(value)); setEditing(false) } }}
      disabled={saving}
      className={FEE_INPUT}
    />
  )
}

function IdCell({ locId, field, value, onSaved }: {
  locId: number
  field: 'region_id' | 'system_id'
  value: number | null
  onSaved: (updated: Location) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value != null ? String(value) : '')
  const [saving, setSaving] = useState(false)

  async function save() {
    const num = draft.trim() === '' ? null : parseInt(draft)
    if (num !== null && isNaN(num)) { setDraft(value != null ? String(value) : ''); setEditing(false); return }
    if (num === value) { setEditing(false); return }
    setSaving(true)
    try {
      const r = await fetch(`/api/locations/${locId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: num }),
      })
      if (r.ok) onSaved(await r.json())
    } finally {
      setSaving(false)
      setEditing(false)
    }
  }

  if (!editing) {
    return (
      <span
        onClick={() => { setDraft(value != null ? String(value) : ''); setEditing(true) }}
        className="font-mono text-[12px] text-muted cursor-pointer hover:text-accent transition-colors"
        title="Click to edit"
      >
        {value ?? <span className="text-faint">—</span>}
      </span>
    )
  }

  return (
    <input
      autoFocus
      type="number"
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setDraft(value != null ? String(value) : ''); setEditing(false) } }}
      disabled={saving}
      className={ID_INPUT}
    />
  )
}

export function LocationsTab() {
  const [locs, setLocs]           = useState<Location[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const [name, setName]         = useState('')
  const [eveId, setEveId]       = useState('')
  const [locType, setLocType]   = useState('station')
  const [systemId, setSystemId] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true); setError(null)
    try {
      const r = await fetch('/api/locations')
      if (!r.ok) throw new Error()
      setLocs(await r.json())
    } catch {
      setError('Failed to load locations.')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(id: number, locName: string) {
    if (!confirm(`Remove ${locName}?`)) return
    const r = await fetch(`/api/locations/${id}`, { method: 'DELETE' })
    if (r.ok || r.status === 204) {
      setLocs(prev => prev.filter(l => l.id !== id))
    } else {
      const d = await r.json().catch(() => ({}))
      setError(d.detail ?? 'Failed to remove location.')
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault(); setFormError(null)
    const parsedSystemId = systemId.trim() ? parseInt(systemId) : null
    try {
      const r = await fetch('/api/locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          eve_id: parseInt(eveId),
          location_type: locType,
          system_id: parsedSystemId,
        }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail ?? 'Failed to create') }
      const created = await r.json()
      setLocs(prev => [...prev, created])
      setName(''); setEveId(''); setLocType('station'); setSystemId('')
    } catch (err: any) {
      setFormError(err.message)
    }
  }

  function handleFeeSaved(updated: Location) {
    setLocs(prev => prev.map(l => l.id === updated.id ? updated : l))
  }

  if (loading) return <p className="text-muted text-[13px]">Loading…</p>
  if (error)   return <p className="text-eve-red text-[13px]">{error}</p>

  return (
    <div>
      <div className="rounded border border-wire overflow-hidden overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-wire bg-surface-hi">
              <th className={TH}>Name</th>
              <th className={TH}>Type</th>
              <th className={`${TH} text-right`}>EVE ID</th>
              <th className={`${TH} text-right`}>Region ID</th>
              <th className={`${TH} text-right`}>System ID</th>
              <th className={`${TH} text-right`} title="Broker's Fee">Broker</th>
              <th className={`${TH} text-right`} title="Sales Tax">Sales tax</th>
              <th className={`${TH} text-right`} title="SCC Surcharge">SCC</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {locs.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-muted">No locations configured.</td></tr>
            )}
            {locs.map(loc => (
              <tr key={loc.id} className="border-t border-wire hover:bg-surface-hi">
                <td className="px-4 py-3 text-primary font-medium">{loc.name}</td>
                <td className="px-4 py-3">
                  <span className="text-[11px] px-1.5 py-0.5 rounded border border-wire text-muted">
                    {loc.location_type === 'station' ? 'Station' : 'Structure'}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-[12px] text-muted text-right">{loc.eve_id}</td>
                <td className="px-4 py-3 text-right">
                  <IdCell locId={loc.id} field="region_id" value={loc.region_id} onSaved={handleFeeSaved} />
                </td>
                <td className="px-4 py-3 text-right">
                  <IdCell locId={loc.id} field="system_id" value={loc.system_id} onSaved={handleFeeSaved} />
                </td>
                <td className="px-4 py-3 text-right">
                  <FeeCell locId={loc.id} field="broker_fee_pct" value={loc.broker_fee_pct} onSaved={handleFeeSaved} />
                </td>
                <td className="px-4 py-3 text-right">
                  <FeeCell locId={loc.id} field="sales_tax_pct" value={loc.sales_tax_pct} onSaved={handleFeeSaved} />
                </td>
                <td className="px-4 py-3 text-right">
                  <FeeCell locId={loc.id} field="scc_surcharge_pct" value={loc.scc_surcharge_pct} onSaved={handleFeeSaved} />
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => handleDelete(loc.id, loc.name)}
                    className="text-[12px] px-2.5 py-1 rounded border border-wire text-muted hover:border-eve-red hover:text-eve-red transition-colors"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-faint mt-2">Click any fee value to edit it.</p>

      {/* Add form */}
      <div className="mt-6">
        <div className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-3">Add Location</div>
        {formError && <p className="text-[12px] text-eve-red mb-3">{formError}</p>}
        <form onSubmit={handleCreate} className="flex flex-wrap gap-2 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Jita 4-4" required className={`${INPUT} w-44`} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted">Type</label>
            <select value={locType} onChange={e => setLocType(e.target.value)} className={INPUT}>
              <option value="station">Station</option>
              <option value="structure">Structure</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted">EVE ID</label>
            <input type="number" value={eveId} onChange={e => setEveId(e.target.value)} placeholder="60003760" required className={`${INPUT} w-36`} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted">System ID</label>
            <input type="number" value={systemId} onChange={e => setSystemId(e.target.value)} placeholder="30000142" className={`${INPUT} w-32`} />
          </div>
          <button type="submit" className="px-4 py-1.5 text-[13px] border border-accent text-accent rounded hover:bg-accent hover:text-canvas transition-colors">
            Add
          </button>
        </form>
        <p className="text-[11px] text-faint mt-2">
          Region is resolved automatically from SDE. For NPC stations, EVE ID is enough.
          For player structures, also enter the System ID so the correct region can be looked up.
          Example — Jita 4-4: EVE ID 60003760, System ID 30000142.
          Fees default to NPC station with perfect skills (broker 3.5%, sales tax 3.6%, SCC 0%).
        </p>
      </div>
    </div>
  )
}
