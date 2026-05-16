'use client'

import { useState, useEffect, useMemo, type FormEvent } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Image from 'next/image'

// ── Types ─────────────────────────────────────────────────────────────────────

type FitStatus = 'ready' | 'partial' | 'short' | 'unknown'
type DocStatus  = 'ready' | 'partial' | 'short' | 'unknown'

interface ItemRow {
  type_id: number
  name: string
  qty_per_fit: number
  qty_needed: number
  qty_available: number
  staging_price: number | null
  jita_price: number | null
  import_cost: number | null
  profit_to_import: number | null
}

interface FitEntry {
  df_id: number
  fit_id: number
  fit_name: string
  hull: string
  ship_type_id: number
  raw_eft: string | null
  doctrine_id: number
  doctrine_name: string
  location_name: string | null
  system: string | null
  stock: number | null
  target: number
  staging_price: number | null
  jita_price: number | null
  import_cost: number | null
  sold_7d: number
  sold_30d: number
  missing_items: { name: string; qty: number }[]
  item_rows: ItemRow[]
  status: FitStatus
}

interface DoctrineInfo {
  id: number
  name: string
  description: string | null
  location_id: number | null
  location_name: string | null
  status: DocStatus
}

interface Location { id: number; name: string }
interface FitSummary { id: number; name: string; hull: string; item_count: number }

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_DOT: Record<DocStatus, string> = {
  ready: 'bg-eve-green', partial: 'bg-eve-amber', short: 'bg-eve-red', unknown: 'bg-muted',
}

function iska(n: number | null): string {
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

function stockTextColor(stock: number | null, target: number): string {
  if (stock === null) return 'text-muted'
  const pct = target > 0 ? stock / target : 0
  if (pct >= 1.0) return 'text-eve-green'
  if (pct >= 0.7) return 'text-eve-amber'
  return 'text-eve-red'
}

function stockBarColor(stock: number | null, target: number): string {
  if (stock === null) return 'bg-muted'
  const pct = target > 0 ? stock / target : 0
  if (pct >= 1.0) return 'bg-eve-green'
  if (pct >= 0.7) return 'bg-eve-amber'
  return 'bg-eve-red'
}

function buildMultibuy(items: { name: string; qty: number }[]): string {
  return items.map(i => `${i.name} x${i.qty}`).join('\n')
}

function buildReport(fits: FitEntry[]): string {
  const utcStr = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const lines: string[] = ['AVAILABILITY REPORT', `Generated: ${utcStr} UTC`, '']
  const groups = new Map<number, { name: string; fits: FitEntry[] }>()
  for (const fit of fits) {
    if (!groups.has(fit.doctrine_id))
      groups.set(fit.doctrine_id, { name: fit.doctrine_name, fits: [] })
    groups.get(fit.doctrine_id)!.fits.push(fit)
  }
  for (const [, g] of groups) {
    lines.push(`━━━ ${g.name} ━━━`)
    for (const fit of g.fits) {
      const below = fit.stock !== null && fit.stock < fit.target
      const importCheaper = fit.import_cost !== null && fit.staging_price !== null && fit.import_cost < fit.staging_price
      lines.push(`  ${below ? '✗' : '✓'} ${fit.fit_name} (${fit.stock ?? '?'} / ${fit.target})`)
      lines.push(`    Staging: ${iska(fit.staging_price)}  Import: ${iska(fit.import_cost)}${importCheaper ? ' ← cheaper' : ''}`)
      if (fit.missing_items.length > 0) {
        lines.push('    Missing:')
        for (const mi of fit.missing_items)
          lines.push(`      – ${mi.name} ×${mi.qty.toLocaleString()}`)
      }
    }
    lines.push('')
  }
  const below = fits.filter(f => f.stock !== null && f.stock < f.target).length
  lines.push('SUMMARY', `  Fits tracked : ${fits.length}`, `  Below target : ${below}`)
  return lines.join('\n')
}

function dedupeByFitId(fits: FitEntry[]): FitEntry[] {
  const best = new Map<number, FitEntry>()
  for (const fit of fits) {
    const shortfall = Math.max(0, fit.target - (fit.stock ?? 0))
    const prev = best.get(fit.fit_id)
    const prevShortfall = prev ? Math.max(0, prev.target - (prev.stock ?? 0)) : -1
    if (shortfall > prevShortfall) best.set(fit.fit_id, fit)
  }
  return [...best.values()]
}

function docMissingItems(fits: FitEntry[]): { name: string; qty: number }[] {
  const acc = new Map<string, number>()
  for (const fit of dedupeByFitId(fits))
    for (const mi of fit.missing_items)
      acc.set(mi.name, (acc.get(mi.name) ?? 0) + mi.qty)
  return [...acc.entries()].map(([name, qty]) => ({ name, qty }))
}

function costToTarget(fits: FitEntry[]): number {
  let total = 0
  for (const fit of dedupeByFitId(fits)) {
    const missing = Math.max(0, fit.target - (fit.stock ?? 0))
    if (missing > 0 && fit.import_cost != null)
      total += missing * fit.import_cost
  }
  return total
}

// ── Style constants ───────────────────────────────────────────────────────────

const INPUT = 'bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary placeholder:text-faint focus:outline-none focus:border-accent transition-colors w-full'
const BTN_PRIMARY = 'px-4 py-1.5 text-[13px] border border-accent text-accent rounded hover:bg-accent hover:text-canvas transition-colors disabled:opacity-50'
const BTN_GHOST = 'px-3 py-1.5 text-[13px] border border-wire text-muted rounded hover:text-secondary transition-colors'
const BTN_TAB_ACTIVE = 'flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded border border-accent text-accent bg-accent/10 transition-colors'
const BTN_TAB = 'flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded border border-wire text-muted hover:text-secondary transition-colors'

// ── Modal shell ───────────────────────────────────────────────────────────────

function Modal({ title, onClose, wide, children }: {
  title: string; onClose: () => void; wide?: boolean; children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className={`bg-surface border border-wire rounded w-full ${wide ? 'max-w-xl' : 'max-w-md'}`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-wire">
          <span className="text-[13px] font-semibold text-primary">{title}</span>
          <button onClick={onClose} className="text-muted hover:text-primary text-lg leading-none w-6 h-6 flex items-center justify-center">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

// ── Doctrine modals ───────────────────────────────────────────────────────────

const INPUT_BARE = 'bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary placeholder:text-faint focus:outline-none focus:border-accent transition-colors'

interface PendingFit { fitId: number | null; eft: string | null; label: string; target: number }

function CreateDoctrineModal({ locations, onClose, onCreated }: {
  locations: Location[]
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName]         = useState('')
  const [desc, setDesc]         = useState('')
  const [locId, setLocId]       = useState('')
  const [error, setError]       = useState<string | null>(null)
  const [saving, setSaving]     = useState(false)
  const [fitOptions, setFitOptions] = useState<FitSummary[]>([])
  const [pendingFits, setPendingFits] = useState<PendingFit[]>([])
  const [addMode, setAddMode]   = useState<'existing' | 'eft'>('existing')
  const [addFitId, setAddFitId] = useState('')
  const [addEft, setAddEft]     = useState('')
  const [addTarget, setAddTarget] = useState('')

  useEffect(() => {
    fetch('/api/fits').then(r => r.json()).then(setFitOptions).catch(() => {})
  }, [])

  function addPendingFit() {
    const tgt = addTarget === '' ? 0 : Math.max(0, +addTarget || 0)
    if (addMode === 'existing') {
      const fid = +addFitId
      if (!fid) return
      if (pendingFits.some(p => p.fitId === fid)) return
      const fit = fitOptions.find(f => f.id === fid)
      if (!fit) return
      setPendingFits(prev => [...prev, { fitId: fid, eft: null, label: `${fit.name} (${fit.hull})`, target: tgt }])
      setAddFitId('')
    } else {
      const p = parseEftPreview(addEft)
      if (!p) return
      setPendingFits(prev => [...prev, { fitId: null, eft: addEft, label: `${p.fitName} (${p.hull})`, target: tgt }])
      setAddEft('')
    }
    setAddTarget('')
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault(); setError(null); setSaving(true)
    try {
      const r = await fetch('/api/doctrines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc || null, location_id: locId ? +locId : null }),
      })
      if (!r.ok) throw new Error('Failed to create doctrine')
      const { id: doctrineId } = await r.json()
      for (const pf of pendingFits) {
        let fitId = pf.fitId
        if (fitId === null && pf.eft) {
          const rf = await fetch('/api/fits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ eft: pf.eft }),
          })
          if (!rf.ok) { const d = await rf.json(); throw new Error(d.detail ?? 'Failed to create fit') }
          fitId = (await rf.json()).id
        }
        await fetch(`/api/doctrines/${doctrineId}/fits`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fit_id: fitId, target_qty: pf.target }),
        })
      }
      onCreated()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const availableFits = fitOptions.filter(f => !pendingFits.some(p => p.fitId === f.id))
  const eftPreview = parseEftPreview(addEft)
  const canAdd = addMode === 'existing' ? !!addFitId : !!eftPreview

  return (
    <Modal title="New Doctrine" onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="text-[12px] text-eve-red">{error}</p>}
        <div className="space-y-1">
          <label className="text-[11px] text-muted">Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Leshak Doctrine" required className={INPUT} />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted">Description (optional)</label>
          <input value={desc} onChange={e => setDesc(e.target.value)} className={INPUT} />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted">Staging Location</label>
          <select value={locId} onChange={e => setLocId(e.target.value)} className={INPUT}>
            <option value="">None</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-[11px] text-muted">Fits (optional)</label>
          {pendingFits.length > 0 && (
            <ul className="space-y-1">
              {pendingFits.map((pf, i) => (
                <li key={i} className="flex items-center gap-2 text-[12px] bg-canvas border border-wire rounded px-3 py-1.5">
                  <span className="flex-1 text-primary truncate">{pf.label}</span>
                  <span className="text-muted shrink-0">×{pf.target}</span>
                  <button type="button" onClick={() => setPendingFits(prev => prev.filter((_, j) => j !== i))}
                    className="text-muted hover:text-eve-red leading-none shrink-0">×</button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-1 mb-2">
            {(['existing', 'eft'] as const).map(m => (
              <button key={m} type="button" onClick={() => setAddMode(m)}
                className={['text-[11px] px-2 py-0.5 rounded border transition-colors',
                  addMode === m ? 'border-accent text-accent' : 'border-wire text-muted hover:text-secondary',
                ].join(' ')}>
                {m === 'existing' ? 'Existing' : 'EFT'}
              </button>
            ))}
          </div>
          {addMode === 'existing' ? (
            <div className="flex gap-2">
              <select value={addFitId} onChange={e => setAddFitId(e.target.value)}
                className={`${INPUT_BARE} flex-1 min-w-0`}>
                <option value="">Select fit…</option>
                {availableFits.map(f => <option key={f.id} value={f.id}>{f.name} ({f.hull})</option>)}
              </select>
              <input type="number" min="1" value={addTarget} onChange={e => setAddTarget(e.target.value)}
                className={`${INPUT_BARE} w-14 text-right shrink-0`} title="Target" />
              <button type="button" onClick={addPendingFit} disabled={!canAdd}
                className="px-3 py-1.5 rounded border border-wire text-[12px] text-muted hover:text-primary hover:border-accent disabled:opacity-40 transition-colors shrink-0">+</button>
            </div>
          ) : (
            <div className="space-y-2">
              <textarea value={addEft} onChange={e => setAddEft(e.target.value)}
                placeholder={'[Leshak, My Leshak]\nEntropic Disintegrator Mutaplasmid…'}
                rows={4}
                className="bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary placeholder:text-faint focus:outline-none focus:border-accent transition-colors w-full resize-none" />
              {eftPreview && (
                <div className="text-[11px] text-muted bg-canvas border border-wire rounded px-3 py-2">
                  <span className="text-secondary font-medium">{eftPreview.hull}</span>
                  <span className="mx-1.5">·</span>
                  <span className="text-primary">{eftPreview.fitName}</span>
                  <span className="mx-1.5">·</span>
                  {eftPreview.itemCount} items
                </div>
              )}
              <div className="flex gap-2 items-center">
                <span className="text-[11px] text-muted">Target</span>
                <input type="number" min="1" value={addTarget} onChange={e => setAddTarget(e.target.value)}
                  className={`${INPUT_BARE} w-14 text-right`} />
                <button type="button" onClick={addPendingFit} disabled={!canAdd}
                  className="px-3 py-1.5 rounded border border-wire text-[12px] text-muted hover:text-primary hover:border-accent disabled:opacity-40 transition-colors">
                  Add Fit
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className={BTN_GHOST}>Cancel</button>
          <button type="submit" disabled={saving} className={BTN_PRIMARY}>{saving ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  )
}

function EditDoctrineModal({ doctrine, locations, onClose, onSaved }: {
  doctrine: DoctrineInfo
  locations: Location[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(doctrine.name)
  const [desc, setDesc] = useState(doctrine.description ?? '')
  const [locId, setLocId] = useState(doctrine.location_id ? String(doctrine.location_id) : '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault(); setError(null); setSaving(true)
    try {
      const r = await fetch(`/api/doctrines/${doctrine.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc || null, location_id: locId ? +locId : null }),
      })
      if (!r.ok) throw new Error('Failed to save')
      onSaved()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Edit Doctrine" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="text-[12px] text-eve-red">{error}</p>}
        <div className="space-y-1">
          <label className="text-[11px] text-muted">Name</label>
          <input value={name} onChange={e => setName(e.target.value)} required className={INPUT} />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted">Description</label>
          <input value={desc} onChange={e => setDesc(e.target.value)} className={INPUT} />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-muted">Staging Location</label>
          <select value={locId} onChange={e => setLocId(e.target.value)} className={INPUT}>
            <option value="">None</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className={BTN_GHOST}>Cancel</button>
          <button type="submit" disabled={saving} className={BTN_PRIMARY}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

function parseEftPreview(eft: string) {
  const lines = eft.trim().split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return null
  const m = lines[0].match(/^\[(.+),\s*(.+)\]$/)
  if (!m) return null
  return {
    hull: m[1].trim(),
    fitName: m[2].trim(),
    itemCount: lines.slice(1).filter(l => !l.startsWith('[') && !l.startsWith('--')).length,
  }
}

function AddFitModal({ doctrineId, onClose, onAdded }: {
  doctrineId: number
  onClose: () => void
  onAdded: () => void
}) {
  const [mode, setMode] = useState<'existing' | 'eft'>('existing')
  const [fits, setFits] = useState<FitSummary[]>([])
  const [fitId, setFitId] = useState('')
  const [target, setTarget] = useState('')
  const [eft, setEft] = useState('')
  const [preview, setPreview] = useState<ReturnType<typeof parseEftPreview>>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/fits').then(r => r.json()).then(setFits).catch(() => {})
  }, [])

  useEffect(() => { setPreview(parseEftPreview(eft)) }, [eft])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault(); setError(null); setSaving(true)
    try {
      let fid = +fitId
      if (mode === 'eft') {
        if (!preview) throw new Error('Invalid EFT format')
        const r = await fetch('/api/fits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eft }),
        })
        if (!r.ok) {
          const d = await r.json()
          throw new Error(d.detail ?? 'Failed to create fit')
        }
        fid = (await r.json()).id
      }
      if (!fid) throw new Error('Select a fit')
      const r = await fetch(`/api/doctrines/${doctrineId}/fits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fit_id: fid, target_qty: target === '' ? 0 : Math.max(0, +target || 0) }),
      })
      if (!r.ok) throw new Error('Failed to add fit')
      onAdded()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Add Fit to Doctrine" onClose={onClose} wide>
      <div className="flex gap-2 mb-4">
        {(['existing', 'eft'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className={['text-[12px] px-3 py-1 rounded border transition-colors',
              mode === m ? 'border-accent text-accent' : 'border-wire text-muted hover:text-secondary',
            ].join(' ')}>
            {m === 'existing' ? 'Existing Fit' : 'New via EFT'}
          </button>
        ))}
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="text-[12px] text-eve-red">{error}</p>}
        {mode === 'existing' ? (
          <div className="space-y-1">
            <label className="text-[11px] text-muted">Fit</label>
            <select value={fitId} onChange={e => setFitId(e.target.value)} required className={INPUT}>
              <option value="">Select fit…</option>
              {fits.map(f => <option key={f.id} value={f.id}>{f.name} ({f.hull})</option>)}
            </select>
          </div>
        ) : (
          <div className="space-y-1">
            <label className="text-[11px] text-muted">EFT String</label>
            <textarea
              value={eft} onChange={e => setEft(e.target.value)}
              placeholder={'[Leshak, My Leshak]\nEntropic Disintegrator Mutaplasmid…'}
              rows={6}
              className="bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary placeholder:text-faint focus:outline-none focus:border-accent transition-colors w-full resize-none"
            />
            {preview && (
              <div className="text-[11px] text-muted bg-canvas border border-wire rounded px-3 py-2 mt-1">
                <span className="text-secondary font-medium">{preview.hull}</span>
                <span className="mx-1.5">·</span>
                <span className="text-primary">{preview.fitName}</span>
                <span className="mx-1.5">·</span>
                {preview.itemCount} items
              </div>
            )}
          </div>
        )}
        <div className="space-y-1">
          <label className="text-[11px] text-muted">Target Quantity</label>
          <input type="number" min="1" value={target} onChange={e => setTarget(e.target.value)} required className={INPUT} />
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <button type="button" onClick={onClose} className={BTN_GHOST}>Cancel</button>
          <button type="submit" disabled={saving} className={BTN_PRIMARY}>{saving ? 'Adding…' : 'Add Fit'}</button>
        </div>
      </form>
    </Modal>
  )
}

// ── ItemTable ─────────────────────────────────────────────────────────────────

function ItemTable({ rows, targetQty }: { rows: ItemRow[]; targetQty: number }) {
  return (
    <div className="border-t border-wire bg-canvas overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-wire bg-surface-hi">
            <th className="px-3 py-2 w-8" />
            <th className="text-left px-2 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider">Item</th>
            <th className="text-right px-4 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider">Qty / fit</th>
            <th className="text-right px-4 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider">Need</th>
            <th className="text-right px-4 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider">In stock</th>
            <th className="text-right px-4 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider">Staging</th>
            <th className="text-right px-4 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider">Import</th>
            <th className="text-right px-4 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider">Profit/u</th>
            <th className="text-right px-4 py-2 text-[10px] font-semibold text-muted uppercase tracking-wider">Margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const short = row.qty_available < row.qty_needed

            const importColor =
              row.import_cost != null && (row.staging_price == null || row.import_cost < row.staging_price)
                ? 'text-eve-green'
                : 'text-muted'

            return (
              <tr key={row.type_id} className={`border-t border-wire ${short ? 'bg-eve-red/5' : ''}`}>
                <td className="pl-3 pr-1 py-1.5">
                  <Image
                    src={`https://images.evetech.net/types/${row.type_id}/icon?size=32`}
                    alt=""
                    width={24}
                    height={24}
                    className="rounded-sm opacity-80 flex-shrink-0"
                    unoptimized
                  />
                </td>
                <td className="px-2 py-1.5 text-primary">{row.name}</td>
                <td className="px-4 py-1.5 text-right font-mono text-muted">{row.qty_per_fit}</td>
                <td className="px-4 py-1.5 text-right font-mono text-muted">{row.qty_needed.toLocaleString()}</td>
                <td className={`px-4 py-1.5 text-right font-mono ${short ? 'text-eve-red' : 'text-secondary'}`}>
                  {row.qty_available.toLocaleString()}
                </td>
                <td className="px-4 py-1.5 text-right font-mono text-muted">{iska(row.staging_price)}</td>
                <td className={`px-4 py-1.5 text-right font-mono ${importColor}`}>{iska(row.import_cost)}</td>
                {(() => {
                  const profitPct = row.profit_to_import != null && row.import_cost != null && row.import_cost > 0
                    ? row.profit_to_import / row.import_cost * 100
                    : null
                  const cls = row.profit_to_import == null ? 'text-muted'
                    : row.profit_to_import > 0 ? 'text-eve-green' : 'text-eve-red'
                  return (
                    <>
                      <td className={`px-4 py-1.5 text-right font-mono ${cls}`}>{iska(row.profit_to_import)}</td>
                      <td className={`px-4 py-1.5 text-right font-mono ${cls}`}>
                        {profitPct != null ? `${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}%` : '—'}
                      </td>
                    </>
                  )
                })()}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── FitRow ────────────────────────────────────────────────────────────────────

function FitRow({ fit, expanded, onToggle, onRemove, onTargetChange }: {
  fit: FitEntry
  expanded: boolean
  onToggle: () => void
  onRemove: () => void
  onTargetChange: (dfId: number, newTarget: number) => void
}) {
  const [eftCopied, setEftCopied] = useState(false)
  const [missingCopied, setMissingCopied] = useState(false)
  const [editingTarget, setEditingTarget] = useState(false)
  const [targetDraft, setTargetDraft] = useState(String(fit.target))

  const hasMissing = fit.missing_items.length > 0
  const fitCost = Math.max(0, fit.target - (fit.stock ?? 0)) * (fit.import_cost ?? 0)

  // negative = staging cheaper than import (good), positive = staging more expensive
  let markupPct: number | null = null
  if (fit.import_cost != null && fit.import_cost > 0 && fit.staging_price != null)
    markupPct = (fit.staging_price - fit.import_cost) / fit.import_cost * 100

  const bothPrices    = fit.import_cost != null && fit.staging_price != null
  const stagingAbsent = fit.staging_price == null && fit.import_cost != null
  const jitaCheaper   = stagingAbsent || (bothPrices && fit.import_cost! < fit.staging_price!)
  const stagingCls    = bothPrices && !jitaCheaper ? 'text-eve-green font-mono' : 'text-muted font-mono'
  const importCls     = jitaCheaper ? 'text-accent font-mono' : 'text-muted font-mono'

  async function copyEft(e: React.MouseEvent) {
    e.stopPropagation()
    if (!fit.raw_eft) return
    await navigator.clipboard.writeText(fit.raw_eft)
    setEftCopied(true)
    setTimeout(() => setEftCopied(false), 1500)
  }

  async function copyMissing(e: React.MouseEvent) {
    e.stopPropagation()
    await navigator.clipboard.writeText(buildMultibuy(fit.missing_items))
    setMissingCopied(true)
    setTimeout(() => setMissingCopied(false), 1500)
  }

  async function saveTarget() {
    const val = parseInt(targetDraft)
    if (!isNaN(val) && val >= 1 && val !== fit.target) {
      await fetch(`/api/doctrines/${fit.doctrine_id}/fits/${fit.df_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_qty: val }),
      })
      onTargetChange(fit.df_id, val)
    } else {
      setTargetDraft(String(fit.target))
    }
    setEditingTarget(false)
  }

  return (
    <div className="rounded border border-wire overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 bg-surface flex-wrap cursor-pointer select-none"
        onClick={onToggle}
      >
        <Image
          src={`https://images.evetech.net/types/${fit.ship_type_id}/render?size=64`}
          alt={fit.hull}
          width={36}
          height={36}
          className="rounded flex-shrink-0 opacity-90"
          unoptimized
        />
        <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
          <span className="text-[13px] font-medium text-primary">{fit.fit_name}</span>
          <span className="text-[11px] text-muted">{fit.hull}</span>
          {fit.system && (
            <span className="text-[11px] text-faint border border-wire rounded px-1.5 py-0.5">{fit.system}</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0" onClick={e => e.stopPropagation()}>
          {fit.raw_eft && (
            <button onClick={copyEft}
              className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                eftCopied ? 'border-eve-green text-eve-green' : 'border-wire text-faint hover:text-secondary hover:border-secondary'
              }`}>
              {eftCopied ? '✓ EFT' : 'EFT'}
            </button>
          )}
          <span className="w-px h-3.5 bg-wire flex-shrink-0" />
          <button onClick={onRemove}
            className="text-[11px] px-2 py-0.5 rounded border border-wire text-faint hover:border-eve-red hover:text-eve-red transition-colors">
            Remove
          </button>
          <span className="w-px h-3.5 bg-wire flex-shrink-0" />
          <button onClick={onToggle}
            className="text-[11px] w-6 h-6 flex items-center justify-center border border-wire text-muted rounded hover:text-secondary transition-colors"
            aria-label="Toggle items">
            {expanded ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 px-3 py-2 bg-canvas border-t border-wire text-[12px] flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`font-mono tabular-nums ${stockTextColor(fit.stock, fit.target)}`}>
            {fit.stock ?? '—'} /{' '}
            {editingTarget ? (
              <input
                type="number" min="1"
                value={targetDraft}
                onChange={e => setTargetDraft(e.target.value)}
                onBlur={saveTarget}
                onKeyDown={e => { if (e.key === 'Enter') saveTarget(); if (e.key === 'Escape') { setTargetDraft(String(fit.target)); setEditingTarget(false) } }}
                onClick={e => e.stopPropagation()}
                autoFocus
                className="w-12 bg-surface border border-wire rounded px-1 text-right font-mono text-[12px]"
              />
            ) : (
              <span
                className="cursor-pointer hover:text-accent"
                onClick={e => { e.stopPropagation(); setTargetDraft(String(fit.target)); setEditingTarget(true) }}
                title="Click to edit target"
              >{fit.target}</span>
            )}
          </span>
          <div className="h-1.5 w-20 bg-wire rounded-full overflow-hidden flex-shrink-0">
            <div
              className={`h-full rounded-full ${stockBarColor(fit.stock, fit.target)}`}
              style={{ width: `${Math.min((fit.stock != null && fit.target > 0 ? fit.stock / fit.target : 0) * 100, 100)}%` }}
            />
          </div>
        </div>
        <span className={stagingCls}>Staging {iska(fit.staging_price)}</span>
        {fit.jita_price != null && (
          <span className="text-muted font-mono">Jita {iska(fit.jita_price)}</span>
        )}
        {fit.import_cost != null && (
          <span className={importCls}>Import {iska(fit.import_cost)}</span>
        )}
        {markupPct !== null && (
          <span className={`font-mono text-[12px] ${markupPct <= 0 ? 'text-eve-green' : 'text-accent'}`}>
            {markupPct > 0 ? '+' : ''}{markupPct.toFixed(1)}%
          </span>
        )}
        <span className="text-faint text-[11px]">
          Sold <span className="font-mono text-secondary">{fit.sold_7d}</span>/7d
          <span className="mx-1">·</span>
          <span className="font-mono text-secondary">{fit.sold_30d}</span>/30d
        </span>
        {hasMissing && (
          <div className="ml-auto flex items-center gap-2 flex-shrink-0">
            {fitCost > 0 && (
              <span className="text-[11px] text-muted font-mono">{iska(fitCost)}</span>
            )}
            <button onClick={copyMissing}
              className={`text-[11px] px-2.5 py-0.5 rounded border transition-colors ${
                missingCopied ? 'border-eve-green text-eve-green' : 'border-wire text-muted hover:border-secondary hover:text-secondary'
              }`}>
              {missingCopied ? '✓ Copied' : 'Copy missing'}
            </button>
          </div>
        )}
      </div>

      {expanded && fit.item_rows.length > 0 && (
        <ItemTable rows={fit.item_rows} targetQty={fit.target} />
      )}
      {expanded && fit.item_rows.length === 0 && (
        <div className="border-t border-wire bg-canvas px-4 py-3 text-[12px] text-muted">
          No item data — staging location not configured.
        </div>
      )}
    </div>
  )
}

// ── DoctrineSection ───────────────────────────────────────────────────────────

function DoctrineSection({ doctrine, fits, locations, onReload }: {
  doctrine: DoctrineInfo
  fits: FitEntry[]
  locations: Location[]
  onReload: () => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showAddFit, setShowAddFit] = useState(false)
  const [expandedFits, setExpandedFits] = useState<Set<number>>(new Set())
  const [missingCopied, setMissingCopied] = useState(false)

  const missing = docMissingItems(fits)
  const cost = costToTarget(fits)
  const hasMissing = missing.length > 0
  const stockedCount = fits.filter(f => f.stock != null && f.stock >= f.target).length

  function toggleFit(dfId: number) {
    setExpandedFits(prev => {
      const next = new Set(prev)
      next.has(dfId) ? next.delete(dfId) : next.add(dfId)
      return next
    })
  }

  async function handleDelete() {
    if (!confirm(`Delete doctrine "${doctrine.name}"? This cannot be undone.`)) return
    const r = await fetch(`/api/doctrines/${doctrine.id}`, { method: 'DELETE' })
    if (r.ok || r.status === 204) onReload()
  }

  async function handleRemoveFit(fit: FitEntry) {
    if (!confirm(`Remove "${fit.fit_name}" from ${doctrine.name}?`)) return
    const r = await fetch(`/api/doctrines/${doctrine.id}/fits/${fit.df_id}`, { method: 'DELETE' })
    if (r.ok || r.status === 204) onReload()
  }

  async function copyMissing() {
    await navigator.clipboard.writeText(buildMultibuy(missing))
    setMissingCopied(true)
    setTimeout(() => setMissingCopied(false), 1500)
  }

  return (
    <>
      {showEdit && (
        <EditDoctrineModal
          doctrine={doctrine}
          locations={locations}
          onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); onReload() }}
        />
      )}
      {showAddFit && (
        <AddFitModal
          doctrineId={doctrine.id}
          onClose={() => setShowAddFit(false)}
          onAdded={() => { setShowAddFit(false); onReload() }}
        />
      )}

      <div className="rounded border border-wire overflow-hidden">
        {/* Doctrine header */}
        <div
          className="flex items-center gap-2 px-4 py-3 bg-surface-hi flex-wrap cursor-pointer select-none"
          onClick={() => setCollapsed(c => !c)}
        >
          <button
            onClick={e => { e.stopPropagation(); setCollapsed(c => !c) }}
            className="text-[11px] w-5 h-5 flex items-center justify-center text-muted hover:text-secondary transition-colors flex-shrink-0"
            aria-label={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? '▶' : '▼'}
          </button>
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[doctrine.status]}`} />
          <span className="text-[14px] font-semibold text-primary">{doctrine.name}</span>
          {doctrine.location_name && (
            <span className="text-[11px] text-faint border border-wire rounded px-1.5 py-0.5">{doctrine.location_name}</span>
          )}
          <span className="text-[11px] text-muted">{stockedCount}/{fits.length} stocked</span>

          <div className="ml-auto flex items-center gap-1.5 flex-shrink-0 flex-wrap" onClick={e => e.stopPropagation()}>
            {hasMissing && (
              <>
                {cost > 0 && (
                  <span className="text-[11px] text-muted font-mono">{iska(cost)}</span>
                )}
                <button
                  onClick={copyMissing}
                  className={`text-[11px] px-2.5 py-0.5 rounded border transition-colors ${
                    missingCopied ? 'border-eve-green text-eve-green' : 'border-wire text-muted hover:border-secondary hover:text-secondary'
                  }`}
                >
                  {missingCopied ? '✓ Copied' : 'Copy missing'}
                </button>
              </>
            )}
            <button onClick={() => setShowEdit(true)}
              className="text-[11px] px-2.5 py-0.5 rounded border border-wire text-muted hover:text-secondary transition-colors">
              Edit
            </button>
            <button onClick={() => setShowAddFit(true)}
              className="text-[11px] px-2.5 py-0.5 rounded border border-accent text-accent hover:bg-accent/10 transition-colors">
              + Fit
            </button>
            <button onClick={handleDelete}
              className="text-[11px] px-2.5 py-0.5 rounded border border-wire text-faint hover:border-eve-red hover:text-eve-red transition-colors">
              Delete
            </button>
          </div>
        </div>

        {/* Fit list */}
        {!collapsed && (
          <div className="p-3 space-y-2 bg-canvas">
            {fits.length === 0 ? (
              <p className="text-[12px] text-muted text-center py-4">
                No fits added yet.{' '}
                <button onClick={() => setShowAddFit(true)} className="text-accent hover:underline">Add one.</button>
              </p>
            ) : (
              fits.map(fit => (
                <FitRow
                  key={`${fit.doctrine_id}-${fit.fit_id}`}
                  fit={fit}
                  expanded={expandedFits.has(fit.df_id)}
                  onToggle={() => toggleFit(fit.df_id)}
                  onRemove={() => handleRemoveFit(fit)}
                  onTargetChange={(dfId, newTarget) =>
                    setAllFits(prev => prev.map(f => f.df_id === dfId ? { ...f, target: newTarget } : f))
                  }
                />
              ))
            )}
          </div>
        )}
      </div>
    </>
  )
}

// ── StatCard ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, variant }: {
  label: string; value: React.ReactNode; variant?: 'red' | 'blue'
}) {
  const cls = variant === 'red' ? 'text-eve-red' : variant === 'blue' ? 'text-accent' : 'text-primary'
  return (
    <div className="bg-surface border border-wire rounded px-4 py-3 min-w-[130px]">
      <div className={`text-[20px] font-bold font-mono leading-tight ${cls}`}>{value}</div>
      <div className="text-[11px] text-muted mt-0.5">{label}</div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function AvailabilityClient() {
  const searchParams   = useSearchParams()
  const router         = useRouter()
  const pathname       = usePathname()

  const [allFits, setAllFits]         = useState<FitEntry[]>([])
  const [doctrineInfos, setDoctrineInfos] = useState<DoctrineInfo[]>([])
  const [locations, setLocations]     = useState<Location[]>([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)
  const [showCreate, setShowCreate]   = useState(false)
  const [reportCopied, setReportCopied] = useState(false)
  const [search, setSearch]           = useState('')
  const [duplicates, setDuplicates]   = useState<{ fits: { id: number; name: string; doctrines: { id: number; name: string }[] }[] }[]>([])
  const [dupExpanded, setDupExpanded] = useState(false)
  const [merging, setMerging]         = useState(false)

  const belowOnly    = searchParams.get('below') === '1'
  const activeSystem = searchParams.get('system') ?? null

  function setParam(key: string, value: string | null) {
    const p = new URLSearchParams(searchParams)
    value == null ? p.delete(key) : p.set(key, value)
    router.replace(`${pathname}?${p}`)
  }

  function setSystem(sys: string | null) {
    const p = new URLSearchParams(searchParams)
    sys == null ? p.delete('system') : p.set('system', sys)
    router.replace(`${pathname}?${p}`)
  }

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true); setError(null)
    try {
      const [rf, rd, rl] = await Promise.all([
        fetch('/api/availability'),
        fetch('/api/doctrines'),
        fetch('/api/locations'),
      ])
      if (!rf.ok || !rd.ok || !rl.ok) throw new Error()
      const [avail, docs, locs] = await Promise.all([rf.json(), rd.json(), rl.json()])
      setAllFits(avail.fits)
      setDuplicates(avail.duplicate_groups ?? [])
      setDoctrineInfos(docs)
      setLocations(locs)
    } catch {
      setError('Failed to load data.')
    } finally {
      setLoading(false)
    }
  }

  async function mergeDuplicates(group: typeof duplicates[number]) {
    setMerging(true)
    try {
      await fetch('/api/fits/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep_id: group.fits[0].id, merge_ids: group.fits.slice(1).map(f => f.id) }),
      })
      await load()
    } finally {
      setMerging(false)
    }
  }

  const systems = useMemo(() => {
    const s = new Set<string>()
    for (const f of allFits) { if (f.system) s.add(f.system) }
    return [...s].sort()
  }, [allFits])

  const filteredFits = useMemo(() => {
    let fits = allFits
    if (activeSystem !== null) fits = fits.filter(f => f.system === activeSystem)
    if (belowOnly) fits = fits.filter(f => f.stock !== null && f.stock < f.target)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      fits = fits.filter(f =>
        f.doctrine_name.toLowerCase().includes(q) ||
        f.fit_name.toLowerCase().includes(q) ||
        f.hull.toLowerCase().includes(q)
      )
    }
    return fits
  }, [allFits, activeSystem, belowOnly, search])

  const stats = useMemo(() => {
    const below   = filteredFits.filter(f => f.stock !== null && f.stock < f.target)
    const cheaper = filteredFits.filter(f => f.import_cost != null && f.staging_price != null && f.import_cost < f.staging_price)
    const shortfall = below.reduce((sum, f) => sum + (f.target - (f.stock ?? 0)) * (f.import_cost ?? f.jita_price ?? 0), 0)
    return { tracked: filteredFits.length, belowTarget: below.length, jitaCheaper: cheaper.length, shortfall }
  }, [filteredFits])

  const doctrineGroups = useMemo(() => {
    const byDoc = new Map<number, FitEntry[]>()
    for (const fit of filteredFits) {
      if (!byDoc.has(fit.doctrine_id)) byDoc.set(fit.doctrine_id, [])
      byDoc.get(fit.doctrine_id)!.push(fit)
    }
    return doctrineInfos.map(d => ({ doctrine: d, fits: byDoc.get(d.id) ?? [] }))
  }, [filteredFits, doctrineInfos])

  async function handleReport() {
    await navigator.clipboard.writeText(buildReport(filteredFits))
    setReportCopied(true)
    setTimeout(() => setReportCopied(false), 2000)
  }

  if (loading) return <p className="text-muted text-[13px]">Loading…</p>
  if (error)   return <p className="text-eve-red text-[13px]">{error}</p>

  return (
    <>
      {showCreate && (
        <CreateDoctrineModal
          locations={locations}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load() }}
        />
      )}

      {/* Duplicate fits banner */}
      {duplicates.length > 0 && (
        <div className="mb-4 rounded border border-eve-amber bg-eve-amber/10 overflow-hidden">
          <button
            className="w-full flex items-center gap-2 px-4 py-2.5 text-left"
            onClick={() => setDupExpanded(e => !e)}
          >
            <span className="w-2 h-2 rounded-full bg-eve-amber flex-shrink-0" />
            <span className="text-[13px] text-eve-amber font-medium flex-1">
              {duplicates.length} duplicate fit{duplicates.length > 1 ? 's' : ''} detected
            </span>
            <span className="text-[11px] text-muted">{dupExpanded ? '▲' : '▼'}</span>
          </button>
          {dupExpanded && (
            <div className="border-t border-eve-amber/30 px-4 py-3 space-y-3">
              {duplicates.map((group, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="flex-1 space-y-1">
                    {group.fits.map(f => (
                      <div key={f.id} className="text-[12px]">
                        <span className="text-primary font-medium">{f.name}</span>
                        {f.doctrines.length > 0 && (
                          <span className="text-muted ml-2">
                            ({f.doctrines.map(d => d.name).join(', ')})
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() => mergeDuplicates(group)}
                    disabled={merging}
                    className="px-3 py-1 text-[12px] border border-wire text-muted rounded hover:text-primary hover:border-accent disabled:opacity-40 transition-colors shrink-0"
                  >
                    Merge
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Page actions */}
      <div className="flex justify-end gap-2 mb-4">
        <button onClick={handleReport}
          className="px-3 py-1.5 text-[12px] border border-wire text-muted rounded hover:text-secondary transition-colors">
          {reportCopied ? '✓ Copied' : 'Report'}
        </button>
        <button onClick={() => setShowCreate(true)}
          className="px-3 py-1.5 text-[12px] border border-accent text-accent rounded hover:bg-accent hover:text-canvas transition-colors">
          + New Doctrine
        </button>
      </div>

      {/* System filter */}
      {systems.length > 1 && (
        <div className="flex gap-1.5 mb-3 flex-wrap items-center">
          <span className="text-[11px] text-faint mr-1">System:</span>
          <button onClick={() => setSystem(null)} className={activeSystem === null ? BTN_TAB_ACTIVE : BTN_TAB}>All</button>
          {systems.map(sys => (
            <button key={sys} onClick={() => setSystem(sys)} className={activeSystem === sys ? BTN_TAB_ACTIVE : BTN_TAB}>
              {sys}
            </button>
          ))}
        </div>
      )}

      {/* Stat cards */}
      <div className="flex items-start gap-3 mb-4 flex-wrap">
        <StatCard label="Fits tracked"    value={stats.tracked} />
        <StatCard label="Below target"    value={stats.belowTarget}  variant={stats.belowTarget  > 0 ? 'red'  : undefined} />
        <StatCard label="Jita cheaper"    value={stats.jitaCheaper}  variant={stats.jitaCheaper  > 0 ? 'blue' : undefined} />
        <StatCard label="Total shortfall" value={iska(stats.shortfall)} variant={stats.shortfall > 0 ? 'red' : undefined} />
        <div className="ml-auto self-center flex-shrink-0">
          <button onClick={() => setParam('below', belowOnly ? null : '1')} className={belowOnly ? BTN_TAB_ACTIVE : BTN_TAB}>
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${belowOnly ? 'bg-accent' : 'bg-muted'}`} />
            Below target only
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search doctrine, fit, or ship…"
          className="bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary placeholder:text-faint focus:outline-none focus:border-accent transition-colors w-full"
        />
      </div>

      {/* Doctrine sections */}
      {doctrineInfos.length === 0 ? (
        <div className="rounded border border-wire px-4 py-12 text-center text-muted text-[13px]">
          No doctrines yet. Click "+ New Doctrine" to get started.
        </div>
      ) : (
        <div className="space-y-4">
          {doctrineGroups.map(({ doctrine, fits }) => {
            if ((belowOnly || activeSystem !== null || search.trim()) && fits.length === 0) return null
            return (
              <DoctrineSection
                key={doctrine.id}
                doctrine={doctrine}
                fits={fits}
                locations={locations}
                onReload={load}
              />
            )
          })}
        </div>
      )}
    </>
  )
}
