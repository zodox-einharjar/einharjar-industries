'use client'

import { useState, useEffect, type FormEvent } from 'react'

interface Location { id: number; name: string }
interface FreightRoute {
  id: number
  from_id: number; from_name: string
  to_id: number;   to_name: string
  isk_per_m3: number
  value_pct: number
}

const INPUT  = 'bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary placeholder:text-faint focus:outline-none focus:border-accent transition-colors'
const INPUT_SM = 'bg-canvas border border-wire rounded px-2 py-1 text-[12px] text-primary focus:outline-none focus:border-accent transition-colors'

export function FreightRoutesTab() {
  const [routes, setRoutes]     = useState<FreightRoute[]>([])
  const [locs, setLocs]         = useState<Location[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [editId, setEditId]     = useState<number | null>(null)

  // Add form
  const [fromId, setFromId]     = useState('')
  const [toId, setToId]         = useState('')
  const [iskPer, setIskPer]     = useState('')
  const [valPct, setValPct]     = useState('')

  // Edit form (mirrors current row values)
  const [eFrom, setEFrom]       = useState('')
  const [eTo, setETo]           = useState('')
  const [eIsk, setEIsk]         = useState('')
  const [ePct, setEPct]         = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true); setError(null)
    try {
      const [rr, rl] = await Promise.all([fetch('/api/freight-routes'), fetch('/api/locations')])
      if (!rr.ok || !rl.ok) throw new Error()
      setRoutes(await rr.json())
      setLocs(await rl.json())
    } catch {
      setError('Failed to load data.')
    } finally {
      setLoading(false)
    }
  }

  function startEdit(r: FreightRoute) {
    setEditId(r.id)
    setEFrom(String(r.from_id)); setETo(String(r.to_id))
    setEIsk(String(r.isk_per_m3)); setEPct(String(r.value_pct))
    setFormError(null)
  }

  async function handleUpdate(e: FormEvent) {
    e.preventDefault(); setFormError(null)
    try {
      const r = await fetch(`/api/freight-routes/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_id: +eFrom, to_id: +eTo, isk_per_m3: +eIsk, value_pct: +ePct }),
      })
      if (!r.ok) throw new Error('Failed to update')
      const updated = await r.json()
      setRoutes(prev => prev.map(x => x.id === editId ? updated : x))
      setEditId(null)
    } catch (err: any) { setFormError(err.message) }
  }

  async function handleDelete(id: number) {
    if (!confirm('Remove this freight route?')) return
    const r = await fetch(`/api/freight-routes/${id}`, { method: 'DELETE' })
    if (r.ok || r.status === 204) setRoutes(prev => prev.filter(x => x.id !== id))
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault(); setFormError(null)
    try {
      const r = await fetch('/api/freight-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_id: +fromId, to_id: +toId, isk_per_m3: +iskPer, value_pct: +valPct }),
      })
      if (!r.ok) throw new Error('Failed to create')
      const created = await r.json()
      setRoutes(prev => [...prev, created])
      setFromId(''); setToId(''); setIskPer(''); setValPct('')
    } catch (err: any) { setFormError(err.message) }
  }

  if (loading) return <p className="text-muted text-[13px]">Loading…</p>
  if (error)   return <p className="text-eve-red text-[13px]">{error}</p>

  return (
    <div>
      <div className="rounded border border-wire overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-wire bg-surface-hi">
              <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-muted uppercase tracking-wider">From</th>
              <th className="text-left px-4 py-2.5 text-[11px] font-semibold text-muted uppercase tracking-wider">To</th>
              <th className="text-right px-4 py-2.5 text-[11px] font-semibold text-muted uppercase tracking-wider">ISK / m³</th>
              <th className="text-right px-4 py-2.5 text-[11px] font-semibold text-muted uppercase tracking-wider">Collateral %</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {routes.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-muted">No freight routes configured.</td></tr>
            )}
            {routes.map(route =>
              editId === route.id ? (
                // ── Inline edit row ──
                <tr key={route.id} className="border-t border-wire bg-surface-hi">
                  <td className="px-3 py-2">
                    <select value={eFrom} onChange={e => setEFrom(e.target.value)} className={INPUT_SM}>
                      {locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select value={eTo} onChange={e => setETo(e.target.value)} className={INPUT_SM}>
                      {locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input type="number" step="0.01" value={eIsk} onChange={e => setEIsk(e.target.value)}
                      className={`${INPUT_SM} w-28 text-right`} />
                  </td>
                  <td className="px-3 py-2">
                    <input type="number" step="0.01" value={ePct} onChange={e => setEPct(e.target.value)}
                      className={`${INPUT_SM} w-20 text-right`} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1 justify-end">
                      <button onClick={handleUpdate}
                        className="text-[12px] px-2.5 py-1 rounded border border-accent text-accent hover:bg-accent hover:text-canvas transition-colors">
                        Save
                      </button>
                      <button onClick={() => setEditId(null)}
                        className="text-[12px] px-2.5 py-1 rounded border border-wire text-muted hover:text-secondary transition-colors">
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                // ── Display row ──
                <tr key={route.id} className="border-t border-wire hover:bg-surface-hi">
                  <td className="px-4 py-3 text-primary">{route.from_name}</td>
                  <td className="px-4 py-3 text-primary">{route.to_name}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-secondary">
                    {route.isk_per_m3.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-secondary">{route.value_pct.toFixed(2)}%</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => startEdit(route)}
                        className="text-[12px] px-2.5 py-1 rounded border border-wire text-muted hover:text-secondary transition-colors">
                        Edit
                      </button>
                      <button onClick={() => handleDelete(route.id)}
                        className="text-[12px] px-2.5 py-1 rounded border border-wire text-muted hover:border-eve-red hover:text-eve-red transition-colors">
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>

      {/* Add form */}
      <div className="mt-6">
        <div className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-3">Add Freight Route</div>
        {formError && <p className="text-[12px] text-eve-red mb-3">{formError}</p>}
        <form onSubmit={handleCreate} className="flex flex-wrap gap-2 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted">From</label>
            <select value={fromId} onChange={e => setFromId(e.target.value)} required className={INPUT}>
              <option value="">Select…</option>
              {locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted">To</label>
            <select value={toId} onChange={e => setToId(e.target.value)} required className={INPUT}>
              <option value="">Select…</option>
              {locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted">ISK / m³</label>
            <input type="number" step="0.01" value={iskPer} onChange={e => setIskPer(e.target.value)}
              placeholder="1000" required className={`${INPUT} w-28`} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted">Collateral %</label>
            <input type="number" step="0.01" value={valPct} onChange={e => setValPct(e.target.value)}
              placeholder="1.5" required className={`${INPUT} w-24`} />
          </div>
          <button type="submit" className="px-4 py-1.5 text-[13px] border border-accent text-accent rounded hover:bg-accent hover:text-canvas transition-colors">
            Add
          </button>
        </form>
      </div>
    </div>
  )
}
