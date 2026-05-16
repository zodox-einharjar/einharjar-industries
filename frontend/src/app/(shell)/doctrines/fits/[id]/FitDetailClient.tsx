'use client'

import { useState, useEffect, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTopbarActions } from '@/lib/topbar-context'

interface ItemRow {
  type_id: number
  name: string
  qty: number
  qty_available: number | null
  staging_price: number | null
  jita_price: number | null
  source: 'staging' | 'import' | null
}

interface FitDetail {
  id: number
  name: string
  hull: string
  target_qty: number | null
  stock: number | null
  staging_price: number | null
  jita_price: number | null
  doctrines: { id: number; name: string; target_qty: number }[]
  items: ItemRow[]
}

const INPUT = 'bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary placeholder:text-faint focus:outline-none focus:border-accent transition-colors w-full'
const BTN_PRIMARY = 'px-4 py-1.5 text-[13px] border border-accent text-accent rounded hover:bg-accent hover:text-canvas transition-colors disabled:opacity-50'
const BTN_GHOST = 'px-3 py-1.5 text-[13px] border border-wire text-muted rounded hover:text-secondary transition-colors'
const BTN_DANGER = 'px-3 py-1.5 text-[13px] border border-wire text-muted rounded hover:border-eve-red hover:text-eve-red transition-colors'

function isk(n: number | null): string {
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

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-surface border border-wire rounded w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-wire">
          <span className="text-[13px] font-semibold text-primary">{title}</span>
          <button onClick={onClose} className="text-muted hover:text-primary text-lg leading-none w-6 h-6 flex items-center justify-center">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

function SourceTag({ source }: { source: 'staging' | 'import' | null }) {
  if (!source) return null
  return (
    <span className={[
      'text-[10px] px-1.5 py-0.5 rounded border font-medium',
      source === 'staging' ? 'text-eve-green border-eve-green' : 'text-eve-amber border-eve-amber',
    ].join(' ')}>
      {source}
    </span>
  )
}

export function FitDetailClient({ id, fromDoctrineId }: { id: number; fromDoctrineId: number | null }) {
  const { setActions } = useTopbarActions()
  const router = useRouter()
  const [fit, setFit] = useState<FitDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showEdit, setShowEdit] = useState(false)

  // edit form
  const [editName, setEditName] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [editSaving, setEditSaving] = useState(false)

  useEffect(() => {
    setActions(
      <div className="flex gap-2">
        <button onClick={() => setShowEdit(true)} className={BTN_GHOST}>Edit Fit</button>
        <button onClick={handleDelete} className={BTN_DANGER}>Delete</button>
      </div>
    )
    return () => setActions(null)
  }, [setActions, fit]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [id, fromDoctrineId])

  async function load() {
    setLoading(true); setError(null)
    try {
      const qs = fromDoctrineId ? `?doctrine_id=${fromDoctrineId}` : ''
      const r = await fetch(`/api/fits/${id}${qs}`)
      if (!r.ok) throw new Error()
      const data = await r.json()
      setFit(data)
      setEditName(data.name)
    } catch {
      setError('Failed to load fit.')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete() {
    if (!fit) return
    if (!confirm(`Delete fit "${fit.name}"? This will remove it from all doctrines.`)) return
    const r = await fetch(`/api/fits/${id}`, { method: 'DELETE' })
    if (r.ok || r.status === 204) {
      router.push(fromDoctrineId ? `/doctrines/${fromDoctrineId}` : '/doctrines')
    }
  }

  async function handleEditSave(e: FormEvent) {
    e.preventDefault(); setEditError(null); setEditSaving(true)
    try {
      const r = await fetch(`/api/fits/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName }),
      })
      if (!r.ok) throw new Error('Failed to save')
      setFit(prev => prev ? { ...prev, name: editName } : prev)
      setShowEdit(false)
    } catch (err: any) {
      setEditError(err.message)
    } finally {
      setEditSaving(false)
    }
  }

  if (loading) return <p className="text-muted text-[13px]">Loading…</p>
  if (error)   return <p className="text-eve-red text-[13px]">{error}</p>
  if (!fit) return null

  const backHref = fromDoctrineId ? `/doctrines/${fromDoctrineId}` : '/doctrines'
  const backLabel = fromDoctrineId
    ? (fit.doctrines.find(d => d.id === fromDoctrineId)?.name ?? 'Doctrine')
    : 'Doctrines'

  return (
    <>
      {showEdit && (
        <Modal title="Edit Fit" onClose={() => setShowEdit(false)}>
          <form onSubmit={handleEditSave} className="space-y-4">
            {editError && <p className="text-[12px] text-eve-red">{editError}</p>}
            <div className="space-y-1">
              <label className="text-[11px] text-muted">Name</label>
              <input value={editName} onChange={e => setEditName(e.target.value)} required className={INPUT} />
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <button type="button" onClick={() => setShowEdit(false)} className={BTN_GHOST}>Cancel</button>
              <button type="submit" disabled={editSaving} className={BTN_PRIMARY}>
                {editSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Back */}
      <Link href={backHref} className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-secondary mb-4">
        ‹ {backLabel}
      </Link>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-[18px] font-semibold text-primary">{fit.name}</h1>
        <div className="text-[12px] text-muted mt-0.5">{fit.hull}</div>

        {/* Stats row */}
        <div className="flex flex-wrap gap-4 mt-3">
          {fit.target_qty != null && (
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">Target</div>
              <div className="text-[13px] font-mono text-primary">{fit.target_qty}</div>
            </div>
          )}
          {fit.stock != null && (
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">Stock</div>
              <div className="text-[13px] font-mono text-primary">{fit.stock}</div>
            </div>
          )}
          {fit.staging_price != null && (
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">Staging / fit</div>
              <div className="text-[13px] font-mono text-secondary">{isk(fit.staging_price)}</div>
            </div>
          )}
          {fit.jita_price != null && (
            <div>
              <div className="text-[10px] text-muted uppercase tracking-wider">Import / fit</div>
              <div className="text-[13px] font-mono text-secondary">{isk(fit.jita_price)}</div>
            </div>
          )}
        </div>
      </div>

      {/* Doctrine tags */}
      {fit.doctrines.length > 0 && (
        <div className="mb-5">
          <div className="text-[10px] font-semibold text-faint uppercase tracking-wider mb-2">Used in Doctrines</div>
          <div className="flex flex-wrap gap-1.5">
            {fit.doctrines.map(d => (
              <Link key={d.id} href={`/doctrines/${d.id}`}
                className="text-[11px] px-2 py-0.5 rounded border border-wire text-muted hover:text-secondary hover:border-secondary transition-colors">
                {d.name}
                {d.target_qty != null && <span className="ml-1 text-faint">×{d.target_qty}</span>}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Item table */}
      <div className="rounded border border-wire overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-wire bg-surface-hi">
              <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-muted uppercase tracking-wider">Item</th>
              <th className="text-right px-4 py-2.5 text-[10px] font-semibold text-muted uppercase tracking-wider">Qty / fit</th>
              <th className="text-right px-4 py-2.5 text-[10px] font-semibold text-muted uppercase tracking-wider">In stock</th>
              <th className="text-right px-4 py-2.5 text-[10px] font-semibold text-muted uppercase tracking-wider">Staging</th>
              <th className="text-right px-4 py-2.5 text-[10px] font-semibold text-muted uppercase tracking-wider">Jita</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {fit.items.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted">No items in this fit.</td></tr>
            )}
            {fit.items.map(row => {
              const shortage = row.qty_available != null && fit.target_qty != null
                ? row.qty_available < row.qty * fit.target_qty
                : false
              return (
                <tr key={row.type_id} className={`border-t border-wire ${shortage ? 'bg-eve-red/5' : 'hover:bg-surface-hi'}`}>
                  <td className="px-4 py-2.5 text-primary">{row.name}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">{row.qty}</td>
                  <td className={`px-4 py-2.5 text-right font-mono ${shortage ? 'text-eve-red' : 'text-secondary'}`}>
                    {row.qty_available != null ? row.qty_available.toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">{isk(row.staging_price)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">{isk(row.jita_price)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <SourceTag source={row.source} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
