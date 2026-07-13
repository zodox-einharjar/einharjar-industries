'use client'

import { useState } from 'react'
import Link from 'next/link'

// ── Types ─────────────────────────────────────────────────────────────────────

type FitAction = 'create' | 'update' | 'keep' | 'delete' | 'error'
type DoctrineAction = 'create' | 'update' | 'delete'

interface FitPlanEntry {
  action: FitAction
  source_fit_name: string
  fit_name: string | null
  fit_id: number | null
  ship_name: string | null
  item_count: number
  target_qty_before: number | null
  target_qty_after: number | null
  error: string | null
  warning: string | null
}

interface DoctrinePlanEntry {
  action: DoctrineAction
  name: string
  doctrine_id: number | null
  fits: FitPlanEntry[]
}

interface ImportPlanResponse {
  dry_run: boolean
  doctrines: DoctrinePlanEntry[]
  orphan_fits_deleted: string[]
  duplicate_doctrine_names: string[]
  duplicate_fit_names: string[]
  summary: Record<string, number>
}

// ── Style constants ───────────────────────────────────────────────────────────

const BTN_PRIMARY = 'px-4 py-1.5 text-[13px] border border-accent text-accent rounded hover:bg-accent hover:text-canvas transition-colors disabled:opacity-50'
const BTN_GHOST = 'px-3 py-1.5 text-[13px] border border-wire text-muted rounded hover:text-secondary transition-colors disabled:opacity-50'
const BTN_DANGER = 'px-4 py-1.5 text-[13px] border border-eve-red text-eve-red rounded hover:bg-eve-red hover:text-canvas transition-colors disabled:opacity-50'

const ACTION_BADGE: Record<string, string> = {
  create: 'bg-eve-green/15 text-eve-green',
  update: 'bg-accent/15 text-accent',
  keep: 'bg-muted/15 text-muted',
  delete: 'bg-eve-red/15 text-eve-red',
  error: 'bg-eve-red/15 text-eve-red',
}

function SummaryStat({ label, created, updated, deleted, kept }: {
  label: string; created?: number; updated?: number; deleted?: number; kept?: number
}) {
  const parts: string[] = []
  if (created) parts.push(`${created} created`)
  if (updated) parts.push(`${updated} updated`)
  if (kept) parts.push(`${kept} kept`)
  if (deleted) parts.push(`${deleted} deleted`)
  return (
    <span className="px-2 py-1 rounded border border-wire">
      {label}: {parts.length > 0 ? parts.join(', ') : 'no changes'}
    </span>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export function DoctrineImportClient() {
  const [html, setHtml] = useState('')
  const [plan, setPlan] = useState<ImportPlanResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [applied, setApplied] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  async function runImport(dryRun: boolean) {
    setBusy(true)
    setErr(null)
    try {
      const r = await fetch('/api/doctrines/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, dry_run: dryRun }),
      })
      const data = await r.json().catch(() => null)
      if (!r.ok) throw new Error(data?.detail || `Import failed (${r.status})`)
      setPlan(data as ImportPlanResponse)
      setApplied(!dryRun)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    setPlan(null)
    setApplied(false)
    setErr(null)
  }

  function toggle(name: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  if (!plan) {
    return (
      <div className="max-w-4xl mx-auto py-6 px-4">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-lg font-semibold text-primary">Bulk Import Doctrines</h1>
          <Link href="/availability" className={BTN_GHOST}>Back to Doctrines</Link>
        </div>
        <p className="text-[13px] text-muted mb-4">
          Paste the outerHTML of the alliance doctrine tool's page (right-click the doctrine
          container → Inspect → Copy → Copy outerHTML). This performs a full replace — any
          doctrine not present in the paste will be deleted.
        </p>
        <textarea
          autoFocus
          value={html}
          onChange={e => setHtml(e.target.value)}
          rows={16}
          placeholder="Paste outerHTML here…"
          className="w-full bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary focus:outline-none focus:border-accent resize-y mb-3"
        />
        {err && <div className="text-eve-red text-[13px] mb-3">{err}</div>}
        <div className="flex gap-2">
          <button onClick={() => runImport(true)} disabled={busy || !html.trim()} className={BTN_PRIMARY}>
            {busy ? 'Parsing…' : 'Parse'}
          </button>
        </div>
      </div>
    )
  }

  const deletedDoctrines = plan.doctrines.filter(d => d.action === 'delete')
  const hasDuplicates = plan.duplicate_doctrine_names.length > 0 || plan.duplicate_fit_names.length > 0

  return (
    <div className="max-w-4xl mx-auto py-6 px-4">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold text-primary">
          {applied ? 'Import Applied' : 'Import Preview'}
        </h1>
        <Link href="/availability" className={BTN_GHOST}>Back to Doctrines</Link>
      </div>
      <p className="text-[13px] text-muted mb-4">
        {applied
          ? 'The changes below have been applied.'
          : 'Review the changes below before applying. Nothing has been written to the database yet.'}
      </p>

      {deletedDoctrines.length > 0 && (
        <div className="mb-3 rounded border border-eve-red bg-eve-red/10 px-4 py-3 text-[13px] text-eve-red">
          {applied ? 'Deleted' : 'This will delete'} {deletedDoctrines.length} doctrine(s) not present in this paste: {deletedDoctrines.map(d => d.name).join(', ')}
        </div>
      )}

      {hasDuplicates && (
        <div className="mb-3 rounded border border-eve-amber bg-eve-amber/10 px-4 py-3 text-[13px] text-eve-amber space-y-1">
          {plan.duplicate_doctrine_names.length > 0 && (
            <div>Duplicate doctrine names (first occurrence used): {plan.duplicate_doctrine_names.join(', ')}</div>
          )}
          {plan.duplicate_fit_names.length > 0 && (
            <div>Duplicate fit names within a doctrine (first occurrence used): {plan.duplicate_fit_names.join(', ')}</div>
          )}
        </div>
      )}

      {plan.orphan_fits_deleted.length > 0 && (
        <div className="mb-3 rounded border border-wire bg-canvas px-4 py-3 text-[13px] text-muted">
          {applied ? 'Removed' : 'Will remove'} {plan.orphan_fits_deleted.length} orphaned fit(s) no longer linked to any doctrine: {plan.orphan_fits_deleted.join(', ')}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap mb-4 text-[12px] text-muted">
        <SummaryStat label="Doctrines" created={plan.summary.doctrines_created} updated={plan.summary.doctrines_updated} deleted={plan.summary.doctrines_deleted} />
        <SummaryStat label="Fits" created={plan.summary.fits_created} updated={plan.summary.fits_updated} kept={plan.summary.fits_kept} deleted={plan.summary.fits_deleted} />
        {plan.summary.fits_errored > 0 && (
          <span className="px-2 py-1 rounded bg-eve-red/15 text-eve-red">{plan.summary.fits_errored} error(s)</span>
        )}
      </div>

      <div className="space-y-2 mb-6">
        {plan.doctrines.map(d => (
          <div key={d.name} className="border border-wire rounded">
            <button onClick={() => toggle(d.name)} className="w-full flex items-center justify-between px-4 py-2.5 text-left">
              <span className="flex items-center gap-2 min-w-0">
                <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-medium shrink-0 ${ACTION_BADGE[d.action]}`}>{d.action}</span>
                <span className="text-[13px] text-primary font-medium truncate">{d.name}</span>
                <span className="text-[11px] text-faint shrink-0">{d.fits.length} fit{d.fits.length !== 1 ? 's' : ''}</span>
              </span>
              <span className="text-muted text-[11px] shrink-0">{collapsed.has(d.name) ? '▸' : '▾'}</span>
            </button>
            {!collapsed.has(d.name) && (
              <div className="border-t border-wire divide-y divide-wire">
                {d.fits.map((f, i) => (
                  <div key={i} className="px-4 py-2 flex items-center justify-between text-[12px] gap-3">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-medium shrink-0 ${ACTION_BADGE[f.action]}`}>{f.action}</span>
                      <span className="text-primary truncate">{f.fit_name || f.source_fit_name}</span>
                      {f.ship_name && <span className="text-faint shrink-0">({f.ship_name})</span>}
                    </span>
                    <span className="text-muted shrink-0 text-right">
                      {f.error ? (
                        <span className="text-eve-red">{f.error}</span>
                      ) : (
                        <>
                          {f.item_count} items
                          {f.target_qty_before !== f.target_qty_after && (
                            <span className="ml-2">{f.target_qty_before ?? '—'} → {f.target_qty_after ?? '—'}</span>
                          )}
                          {f.target_qty_before === f.target_qty_after && f.target_qty_after !== null && (
                            <span className="ml-2">target {f.target_qty_after}</span>
                          )}
                        </>
                      )}
                      {f.warning && <span className="text-eve-amber ml-2">{f.warning}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        {!applied ? (
          <>
            <button onClick={() => runImport(false)} disabled={busy} className={BTN_DANGER}>
              {busy ? 'Applying…' : 'Apply'}
            </button>
            <button onClick={reset} disabled={busy} className={BTN_GHOST}>Back</button>
          </>
        ) : (
          <button onClick={() => { setHtml(''); reset() }} className={BTN_GHOST}>Import Another</button>
        )}
      </div>
      {err && <div className="text-eve-red text-[13px] mt-3">{err}</div>}
    </div>
  )
}
