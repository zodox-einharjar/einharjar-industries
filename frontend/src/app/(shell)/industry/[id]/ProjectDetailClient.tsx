'use client'

import { useRouter } from 'next/navigation'
import { useState, useRef } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Material {
  id: number
  type_id: number
  name: string
  quantity_needed: number
  quantity_reserved: number
  qty_available_in_inventory: number
  qty_shortfall: number
}

interface Output {
  id: number
  type_id: number
  name: string
  quantity: number
  is_byproduct: boolean
  jita_sell: number | null
}

interface Job {
  id: number
  name: string
  runs: number
  days: number
  job_cost: number
  is_done: boolean
}

interface Project {
  id: number
  name: string
  status: 'planning' | 'in_progress' | 'complete'
  ravworks_url: string | null
  invention_cost: number
  blueprint_cost: number
  extra_cost: number
  total_job_cost: number
  total_runs_cost: number
  material_cost: number
  total_cost: number
  estimated_revenue: number | null
  estimated_profit: number | null
  estimated_byproduct_value: number | null
  target_margin_pct: number | null
  output_location_id: number | null
  output_location_name: string | null
  materials: Material[]
  outputs: Output[]
  jobs_by_category: Record<string, Job[]>
}

interface Location {
  id: number
  name: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isk(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ISK'
}

function num(n: number) {
  return n.toLocaleString()
}

function parseIsk(s: string): number {
  return parseFloat(s.replace(/[\s,]/g, '')) || 0
}

const STATUS_COLOR: Record<string, string> = {
  planning: 'bg-eve-amber/15 text-eve-amber',
  in_progress: 'bg-accent/15 text-accent',
  complete: 'bg-green-500/15 text-green-400',
}
const STATUS_LABEL: Record<string, string> = {
  planning: 'Planning',
  in_progress: 'In Progress',
  complete: 'Complete',
}

const CATEGORIES = [
  'Intermediate Composite Reactions',
  'Composite Reactions',
  'Biochem Reactions',
  'Hybrid Reactions',
  'Advanced Components',
  'Capital Components',
  'Others',
  'End Product Jobs',
]

// ── Main component ────────────────────────────────────────────────────────────

export function ProjectDetailClient({
  project: initial,
  locations,
}: {
  project: Project
  locations: Location[]
}) {
  const router = useRouter()
  const [project, setProject] = useState(initial)
  const [tab, setTab] = useState<'overview' | 'jobs'>('overview')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function apiCall(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(`/api/industry/${project.id}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(
        typeof err.detail === 'object' ? JSON.stringify(err.detail) : err.detail ?? 'Request failed'
      )
    }
    return res.json()
  }

  async function refresh() {
    const res = await fetch(`/api/industry/${project.id}`)
    if (res.ok) setProject(await res.json())
  }

  async function transition(action: string) {
    setBusy(true)
    setError(null)
    try {
      await apiCall(`/${action}`, 'POST')
      await refresh()
    } catch (e: any) {
      try {
        const parsed = JSON.parse(e.message)
        if (parsed.shortfalls) {
          setError('Insufficient stock:\n' + parsed.shortfalls.join('\n'))
        } else {
          setError(e.message)
        }
      } catch {
        setError(e.message)
      }
    } finally {
      setBusy(false)
    }
  }

  const primaryOutputs = project.outputs.filter(o => !o.is_byproduct)
  const byproducts = project.outputs.filter(o => o.is_byproduct)
  const totalOutputUnits = primaryOutputs.reduce((s, o) => s + o.quantity, 0)
  const unitCost = totalOutputUnits > 0 ? project.total_cost / totalOutputUnits : null

  const profitColor =
    project.estimated_profit == null
      ? 'text-primary'
      : project.estimated_profit >= 0
      ? 'text-green-400'
      : 'text-red-400'

  const activeCategoriesInJobs = CATEGORIES.filter(
    cat => (project.jobs_by_category[cat] ?? []).length > 0
  )

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-xl font-semibold text-primary truncate">{project.name}</h1>
            <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium flex-shrink-0 ${STATUS_COLOR[project.status]}`}>
              {STATUS_LABEL[project.status]}
            </span>
          </div>
          {project.ravworks_url && (
            <a href={project.ravworks_url} target="_blank" rel="noopener noreferrer"
               className="text-[12px] text-accent hover:underline">
              View on Ravworks ↗
            </a>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {project.status === 'planning' && (
            <button onClick={() => transition('start')} disabled={busy}
                    className="px-3 py-1.5 text-[13px] bg-accent text-canvas rounded hover:bg-accent/90 disabled:opacity-50">
              Start Project
            </button>
          )}
          {project.status === 'in_progress' && (
            <>
              <button onClick={() => transition('cancel')} disabled={busy}
                      className="px-3 py-1.5 text-[13px] border border-wire text-muted rounded hover:text-primary disabled:opacity-50">
                Cancel
              </button>
              <button onClick={() => transition('complete')} disabled={busy}
                      className="px-3 py-1.5 text-[13px] bg-green-600 text-white rounded hover:bg-green-500 disabled:opacity-50">
                Complete Project
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-[13px] whitespace-pre-line">
          {error}
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Materials" value={project.material_cost > 0 ? isk(project.material_cost) : '—'} />
        <StatCard label="Invention" value={isk(project.invention_cost)} />
        <StatCard label="Blueprint" value={isk(project.blueprint_cost)} />
        <StatCard label="Extra" value={isk(project.extra_cost)} />
        <StatCard label="Job Cost" value={isk(project.total_runs_cost)} />
        <StatCard label="Total Cost" value={isk(project.total_cost)} highlight />
        {project.estimated_profit != null ? (
          <StatCard
            label="Est. Profit"
            value={isk(project.estimated_profit)}
            valueClass={profitColor}
          />
        ) : (
          <StatCard label="Est. Profit" value="No Jita data" />
        )}
        <StatCard
          label="Byproduct Value"
          value={project.estimated_byproduct_value != null ? isk(project.estimated_byproduct_value) : '—'}
        />
        <StatCard
          label="Target Margin"
          value={project.target_margin_pct != null ? `${project.target_margin_pct}%` : '—'}
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-wire">
        {(['overview', 'jobs'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
                  className={[
                    'px-4 py-2 text-[13px] capitalize border-b-2 -mb-px transition-colors',
                    tab === t ? 'border-accent text-primary' : 'border-transparent text-muted hover:text-primary',
                  ].join(' ')}>
            {t === 'jobs' ? `Jobs${activeCategoriesInJobs.length > 0 ? ` (${activeCategoriesInJobs.length})` : ''}` : 'Overview'}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <OverviewTab
          project={project}
          locations={locations}
          primaryOutputs={primaryOutputs}
          byproducts={byproducts}
          unitCost={unitCost}
          onRefresh={refresh}
        />
      )}
      {tab === 'jobs' && (
        <JobsTab
          project={project}
          activeCategories={activeCategoriesInJobs}
          onRefresh={refresh}
        />
      )}
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  highlight,
  valueClass,
}: {
  label: string
  value: string
  highlight?: boolean
  valueClass?: string
}) {
  return (
    <div className="bg-surface border border-wire rounded-lg px-4 py-3">
      <div className="text-[11px] text-faint uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-[15px] font-semibold tabular-nums ${valueClass ?? (highlight ? 'text-accent' : 'text-primary')}`}>
        {value}
      </div>
    </div>
  )
}

// ── Overview tab ──────────────────────────────────────────────────────────────

function OverviewTab({
  project,
  locations,
  primaryOutputs,
  byproducts,
  unitCost,
  onRefresh,
}: {
  project: Project
  locations: Location[]
  primaryOutputs: Output[]
  byproducts: Output[]
  unitCost: number | null
  onRefresh: () => void
}) {
  const [itemSearch, setItemSearch] = useState('')
  const [searchResults, setSearchResults] = useState<{ type_id: number; name: string }[]>([])
  const [addingMaterial, setAddingMaterial] = useState(false)
  const [addingOutput, setAddingOutput] = useState(false)
  const [pastingMaterials, setPastingMaterials] = useState(false)
  const [pastingOutputs, setPastingOutputs] = useState(false)
  const [copiedMissing, setCopiedMissing] = useState(false)

  function copyMissing() {
    const missing = project.materials.filter(m => m.qty_shortfall > 0)
    const text = missing.map(m => `${m.name} x ${m.qty_shortfall}`).join('\n')
    navigator.clipboard.writeText(text)
    setCopiedMissing(true)
    setTimeout(() => setCopiedMissing(false), 1500)
  }

  async function searchItems(q: string) {
    setItemSearch(q)
    if (q.length < 2) { setSearchResults([]); return }
    const res = await fetch(`/api/industry/search/items?q=${encodeURIComponent(q)}`)
    if (res.ok) setSearchResults(await res.json())
  }

  async function addMaterial(type_id: number, name: string) {
    const qty = prompt(`Quantity needed for ${name}?`)
    if (!qty || isNaN(parseInt(qty))) return
    await fetch(`/api/industry/${project.id}/materials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type_id, quantity_needed: parseInt(qty) }),
    })
    setAddingMaterial(false)
    setItemSearch('')
    setSearchResults([])
    onRefresh()
  }

  async function removeMaterial(id: number) {
    await fetch(`/api/industry/${project.id}/materials/${id}`, { method: 'DELETE' })
    onRefresh()
  }

  async function addOutput(type_id: number, name: string, is_byproduct: boolean) {
    const qty = prompt(`Quantity of ${name} produced?`)
    if (!qty || isNaN(parseInt(qty))) return
    await fetch(`/api/industry/${project.id}/outputs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type_id, quantity: parseInt(qty), is_byproduct }),
    })
    setAddingOutput(false)
    setItemSearch('')
    setSearchResults([])
    onRefresh()
  }

  async function removeOutput(id: number) {
    await fetch(`/api/industry/${project.id}/outputs/${id}`, { method: 'DELETE' })
    onRefresh()
  }

  const canEdit = project.status !== 'complete'

  return (
    <div className="space-y-6">
      {/* Materials */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] font-semibold tracking-widest text-faint uppercase">Materials</div>
          {project.status === 'planning' && (
            <div className="flex items-center gap-3">
              {project.materials.some(m => m.qty_shortfall > 0) && (
                <button onClick={copyMissing}
                        className="text-[12px] text-eve-amber hover:underline">
                  {copiedMissing ? 'Copied!' : 'Copy Missing'}
                </button>
              )}
              {canEdit && (
                <>
                  <button onClick={() => { setPastingMaterials(v => !v); setAddingMaterial(false) }}
                          className="text-[12px] text-accent hover:underline">
                    Paste table
                  </button>
                  <button onClick={() => { setAddingMaterial(!addingMaterial); setPastingMaterials(false) }}
                          className="text-[12px] text-muted hover:text-primary">
                    + Add single
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {pastingMaterials && (
          <BulkPasteBox
            label="Paste Ravworks materials table (Name | To Buy | … | End Amount)"
            placeholder={"Name\tTo Buy\tTo Buy (Sell-Value)\tTo Buy Volume\tStart Amount\tEnd Amount\nTritanium\t4861001\t…"}
            onSubmit={async text => {
              const r = await fetch(`/api/industry/${project.id}/materials/paste`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
              })
              const d = await r.json()
              if (!r.ok) throw new Error(d.detail ?? 'Parse error')
              setPastingMaterials(false)
              onRefresh()
              if (d.skipped?.length) alert(`${d.skipped.length} unknown item(s) skipped:\n${d.skipped.join(', ')}`)
            }}
            onCancel={() => setPastingMaterials(false)}
          />
        )}

        {addingMaterial && (
          <ItemSearchBox value={itemSearch} results={searchResults} onSearch={searchItems}
            onSelect={(tid, name) => addMaterial(tid, name)}
            onClose={() => { setAddingMaterial(false); setItemSearch(''); setSearchResults([]) }}
            placeholder="Search material…" />
        )}

        <div className="bg-surface border border-wire rounded-lg overflow-hidden">
          {project.materials.length === 0 ? (
            <div className="px-4 py-6 text-center text-muted text-[13px]">No materials added</div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-wire text-faint text-[11px] uppercase tracking-wider">
                  <th className="text-left px-4 py-2">Item</th>
                  <th className="text-right px-4 py-2">Needed</th>
                  {project.status === 'planning' && (
                    <>
                      <th className="text-right px-4 py-2">In Inventory</th>
                      <th className="text-right px-4 py-2">Shortfall</th>
                    </>
                  )}
                  {project.status === 'in_progress' && (
                    <th className="text-right px-4 py-2">Reserved</th>
                  )}
                  {canEdit && project.status === 'planning' && <th className="px-4 py-2" />}
                </tr>
              </thead>
              <tbody>
                {project.materials.map(m => (
                  <tr key={m.id} className="border-b border-wire last:border-0">
                    <td className="px-4 py-2 text-primary">{m.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{num(m.quantity_needed)}</td>
                    {project.status === 'planning' && (
                      <>
                        <td className="px-4 py-2 text-right tabular-nums text-muted">
                          {num(m.qty_available_in_inventory)}
                        </td>
                        <td className={`px-4 py-2 text-right tabular-nums ${m.qty_shortfall > 0 ? 'text-red-400' : 'text-green-400'}`}>
                          {m.qty_shortfall > 0 ? `-${num(m.qty_shortfall)}` : '✓'}
                        </td>
                      </>
                    )}
                    {project.status === 'in_progress' && (
                      <td className="px-4 py-2 text-right tabular-nums text-accent">
                        {num(m.quantity_reserved)} in use
                      </td>
                    )}
                    {canEdit && project.status === 'planning' && (
                      <td className="px-4 py-2 text-right">
                        <button onClick={() => removeMaterial(m.id)}
                                className="text-faint hover:text-red-400 text-[11px]">
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Outputs */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] font-semibold tracking-widest text-faint uppercase">Outputs</div>
          {canEdit && (
            <div className="flex items-center gap-3">
              <button onClick={() => { setPastingOutputs(v => !v); setAddingOutput(false) }}
                      className="text-[12px] text-accent hover:underline">
                Paste table
              </button>
              <button onClick={() => { setAddingOutput(!addingOutput); setPastingOutputs(false) }}
                      className="text-[12px] text-muted hover:text-primary">
                + Add single
              </button>
            </div>
          )}
        </div>

        {pastingOutputs && (
          <BulkPasteBox
            label="Paste Ravworks output table (Name | Amount | Volume | …)"
            placeholder={"Name\tAmount\tVolume\tSell Price/Unit\tSell Price\nIshtar\t10\t…"}
            onSubmit={async text => {
              const r = await fetch(`/api/industry/${project.id}/outputs/paste`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
              })
              const d = await r.json()
              if (!r.ok) throw new Error(d.detail ?? 'Parse error')
              setPastingOutputs(false)
              onRefresh()
              if (d.skipped?.length) alert(`${d.skipped.length} unknown item(s) skipped:\n${d.skipped.join(', ')}`)
            }}
            onCancel={() => setPastingOutputs(false)}
          />
        )}

        {addingOutput && (
          <ItemSearchBox value={itemSearch} results={searchResults} onSearch={searchItems}
            onSelect={(tid, name) => addOutput(tid, name, false)}
            onSelectByproduct={(tid, name) => addOutput(tid, name, true)}
            onClose={() => { setAddingOutput(false); setItemSearch(''); setSearchResults([]) }}
            placeholder="Search output item…" showByproduct />
        )}

        <div className="bg-surface border border-wire rounded-lg overflow-hidden">
          {primaryOutputs.length === 0 && byproducts.length === 0 ? (
            <div className="px-4 py-6 text-center text-muted text-[13px]">No outputs added</div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-wire text-faint text-[11px] uppercase tracking-wider">
                  <th className="text-left px-4 py-2">Item</th>
                  <th className="text-left px-4 py-2">Type</th>
                  <th className="text-right px-4 py-2">Quantity</th>
                  <th className="text-right px-4 py-2">Jita Sell</th>
                  {unitCost != null && <th className="text-right px-4 py-2">Est. Unit Cost</th>}
                  {canEdit && <th className="px-4 py-2" />}
                </tr>
              </thead>
              <tbody>
                {[...primaryOutputs, ...byproducts].map(o => (
                  <tr key={o.id} className="border-b border-wire last:border-0">
                    <td className="px-4 py-2 text-primary">{o.name}</td>
                    <td className="px-4 py-2 text-muted text-[12px]">
                      {o.is_byproduct ? 'Byproduct' : 'Output'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{num(o.quantity)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted">
                      {o.jita_sell != null ? isk(o.jita_sell) : '—'}
                    </td>
                    {unitCost != null && (
                      <td className="px-4 py-2 text-right tabular-nums text-muted">
                        {o.is_byproduct ? '—' : isk(unitCost)}
                      </td>
                    )}
                    {canEdit && (
                      <td className="px-4 py-2 text-right">
                        <button onClick={() => removeOutput(o.id)}
                                className="text-faint hover:text-red-400 text-[11px]">
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  )
}

// ── Jobs tab ──────────────────────────────────────────────────────────────────

function JobsTab({
  project,
  activeCategories,
  onRefresh,
}: {
  project: Project
  activeCategories: string[]
  onRefresh: () => void
}) {
  const allJobs = CATEGORIES.flatMap(cat => project.jobs_by_category[cat] ?? [])
  const totalCost = allJobs.reduce((s, j) => s + j.job_cost, 0)
  const doneCost = allJobs.filter(j => j.is_done).reduce((s, j) => s + j.job_cost, 0)
  const doneCount = allJobs.filter(j => j.is_done).length

  const emptyCats = CATEGORIES.filter(c => !activeCategories.includes(c))

  // Active tab: first with jobs, or first category if none
  const [activeCat, setActiveCat] = useState<string>(activeCategories[0] ?? CATEGORIES[0])
  const [addingCat, setAddingCat] = useState(false)
  const [addCatTarget, setAddCatTarget] = useState(emptyCats[0] ?? '')

  // When categories change (after paste), keep activeCat valid
  const displayCat = activeCategories.includes(activeCat) ? activeCat : (activeCategories[0] ?? activeCat)

  function switchCat(cat: string) {
    setActiveCat(cat)
    setAddingCat(false)
  }

  const currentJobs = project.jobs_by_category[displayCat] ?? []
  const catTotalCost = currentJobs.reduce((s, j) => s + j.job_cost, 0)

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-6 text-[13px]">
        <span className="text-muted">
          Total run cost:{' '}
          <span className="text-primary font-medium tabular-nums">{totalCost > 0 ? isk(totalCost) : '—'}</span>
        </span>
        {allJobs.length > 0 && (
          <span className="text-muted">
            Done:{' '}
            <span className="text-green-400 font-medium tabular-nums">
              {doneCount}/{allJobs.length} jobs
            </span>
            {doneCost > 0 && <span className="text-faint ml-1">({isk(doneCost)})</span>}
          </span>
        )}
      </div>

      {/* Category tabs */}
      <div className="flex flex-wrap items-center gap-1">
        {activeCategories.map(cat => {
          const jobs = project.jobs_by_category[cat] ?? []
          const allDone = jobs.length > 0 && jobs.every(j => j.is_done)
          return (
            <button key={cat} onClick={() => switchCat(cat)}
                    className={[
                      'px-2.5 py-1 text-[11px] rounded border transition-colors',
                      displayCat === cat && !addingCat
                        ? 'border-accent text-accent bg-accent/10'
                        : allDone
                        ? 'border-green-500/40 text-green-400/70 bg-green-500/5'
                        : 'border-wire text-muted hover:text-primary',
                    ].join(' ')}>
              {cat}{allDone && <span className="ml-1">✓</span>}
            </button>
          )
        })}

        {/* Add category button */}
        {emptyCats.length > 0 && (
          <button onClick={() => { setAddingCat(true); setAddCatTarget(emptyCats[0]) }}
                  className={[
                    'px-2.5 py-1 text-[11px] rounded border transition-colors',
                    addingCat ? 'border-accent text-accent bg-accent/10' : 'border-dashed border-wire text-faint hover:text-muted',
                  ].join(' ')}>
            + Add category
          </button>
        )}
      </div>

      {/* Add-to-new-category panel */}
      {addingCat && (
        <div className="bg-surface border border-wire rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-3">
            <label className="text-[12px] text-muted whitespace-nowrap">Category:</label>
            <select value={addCatTarget} onChange={e => setAddCatTarget(e.target.value)}
                    className="bg-canvas border border-wire rounded px-2 py-1 text-[13px] text-primary focus:outline-none focus:border-accent">
              {emptyCats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <InlinePaste
            projectId={project.id}
            category={addCatTarget}
            onDone={() => { setAddingCat(false); setActiveCat(addCatTarget); onRefresh() }}
            onCancel={() => setAddingCat(false)}
          />
        </div>
      )}

      {/* Job table for active category */}
      {!addingCat && (
        <div className="bg-surface border border-wire rounded-lg overflow-hidden">
          {activeCategories.length > 0 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-wire">
              <span className="text-[12px] font-medium text-primary">{displayCat}</span>
              {catTotalCost > 0 && (
                <span className="text-[12px] tabular-nums text-muted">{isk(catTotalCost)}</span>
              )}
            </div>
          )}

          {activeCategories.length === 0 && (
            <div className="px-4 py-6 text-center text-muted text-[13px]">
              No jobs yet — use <strong>+ Add category</strong> above to paste your first batch.
            </div>
          )}

          {currentJobs.length > 0 && (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-wire text-faint text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-2 w-8" />
                  <th className="text-left px-4 py-2">Name</th>
                  <th className="text-right px-4 py-2">Runs</th>
                  <th className="text-right px-4 py-2">Days</th>
                  <th className="text-right px-4 py-2">Job Cost</th>
                </tr>
              </thead>
              <tbody>
                {currentJobs.map(j => (
                  <JobRow key={j.id} job={j} projectId={project.id} onRefresh={onRefresh} />
                ))}
              </tbody>
            </table>
          )}

          {activeCategories.length > 0 && (
            <div className="px-4 py-3 border-t border-wire">
              <InlinePaste
                projectId={project.id}
                category={displayCat}
                replaceLabel={currentJobs.length > 0}
                onDone={onRefresh}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Inline paste widget ───────────────────────────────────────────────────────

function InlinePaste({
  projectId,
  category,
  replaceLabel,
  onDone,
  onCancel,
}: {
  projectId: number
  category: string
  replaceLabel?: boolean
  onDone: () => void
  onCancel?: () => void
}) {
  const [open, setOpen] = useState(!onCancel) // auto-open when used standalone
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setErr(null)
    const res = await fetch(`/api/industry/${projectId}/jobs/paste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, text }),
    })
    if (res.ok) {
      setText('')
      setOpen(false)
      onDone()
    } else {
      const e = await res.json().catch(() => ({}))
      setErr(e.detail?.errors?.join('\n') ?? (typeof e.detail === 'string' ? e.detail : 'Parse error'))
    }
    setBusy(false)
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-[12px] text-accent hover:underline">
        {replaceLabel ? 'Replace jobs (paste)' : 'Paste jobs'}
      </button>
    )
  }

  return (
    <div className="space-y-2">
      <textarea
        autoFocus
        value={text}
        onChange={e => setText(e.target.value)}
        rows={8}
        className="w-full bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary focus:outline-none focus:border-accent resize-y"
        placeholder={"Name\tRuns\tDays\tJob Cost\nVexor Blueprint\t1\t0.09\t1,290,525"}
      />
      {err && <div className="text-red-400 text-[12px] whitespace-pre-line">{err}</div>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={busy || !text.trim()}
                className="px-3 py-1.5 text-[12px] bg-accent text-canvas rounded hover:bg-accent/90 disabled:opacity-50">
          {busy ? 'Importing…' : 'Import'}
        </button>
        <button onClick={() => { setOpen(false); setText(''); setErr(null); onCancel?.() }}
                className="px-3 py-1.5 text-[12px] text-muted hover:text-primary">
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Job row with done toggle + inline cost edit ────────────────────────────────

function JobRow({ job, projectId, onRefresh }: { job: Job; projectId: number; onRefresh: () => void }) {
  const [editing, setEditing] = useState(false)
  const [costVal, setCostVal] = useState(String(job.job_cost))
  const inputRef = useRef<HTMLInputElement>(null)

  async function toggleDone() {
    await fetch(`/api/industry/${projectId}/jobs/${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_done: !job.is_done }),
    })
    onRefresh()
  }

  async function saveCost() {
    const parsed = parseIsk(costVal)
    if (isNaN(parsed)) { setEditing(false); return }
    await fetch(`/api/industry/${projectId}/jobs/${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_cost: parsed }),
    })
    setEditing(false)
    onRefresh()
  }

  return (
    <tr className={`border-b border-wire last:border-0 ${job.is_done ? 'opacity-50' : ''}`}>
      <td className="px-4 py-2">
        <input type="checkbox" checked={job.is_done} onChange={toggleDone}
               className="w-3.5 h-3.5 cursor-pointer accent-[var(--accent)]" />
      </td>
      <td className={`px-4 py-2 ${job.is_done ? 'line-through text-muted' : 'text-primary'}`}>
        {job.name}
      </td>
      <td className="px-4 py-2 text-right tabular-nums text-muted">{job.runs}</td>
      <td className="px-4 py-2 text-right tabular-nums text-muted">{job.days.toFixed(2)}</td>
      <td className="px-4 py-2 text-right tabular-nums">
        {editing ? (
          <input
            ref={inputRef}
            autoFocus
            value={costVal}
            onChange={e => setCostVal(e.target.value)}
            onBlur={saveCost}
            onKeyDown={e => { if (e.key === 'Enter') saveCost(); if (e.key === 'Escape') setEditing(false) }}
            className="w-36 bg-canvas border border-accent rounded px-2 py-0.5 text-[12px] text-right font-mono focus:outline-none"
          />
        ) : (
          <button onClick={() => { setCostVal(String(job.job_cost)); setEditing(true) }}
                  className="tabular-nums hover:text-accent transition-colors" title="Click to edit">
            {isk(job.job_cost)}
          </button>
        )}
      </td>
    </tr>
  )
}

// ── Bulk paste box ────────────────────────────────────────────────────────────

function BulkPasteBox({
  label,
  placeholder,
  onSubmit,
  onCancel,
}: {
  label: string
  placeholder: string
  onSubmit: (text: string) => Promise<void>
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setErr(null)
    try {
      await onSubmit(text)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-3 bg-canvas border border-wire rounded-lg p-3 space-y-2">
      <div className="text-[11px] text-muted">{label}</div>
      <textarea
        autoFocus
        value={text}
        onChange={e => setText(e.target.value)}
        rows={6}
        className="w-full bg-surface border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary focus:outline-none focus:border-accent resize-y"
        placeholder={placeholder}
      />
      {err && <div className="text-red-400 text-[12px]">{err}</div>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={busy || !text.trim()}
                className="px-3 py-1.5 text-[12px] bg-accent text-canvas rounded hover:bg-accent/90 disabled:opacity-50">
          {busy ? 'Importing…' : 'Import'}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 text-[12px] text-muted hover:text-primary">
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Item search box ───────────────────────────────────────────────────────────

function ItemSearchBox({
  value, results, onSearch, onSelect, onSelectByproduct, onClose, placeholder, showByproduct,
}: {
  value: string
  results: { type_id: number; name: string }[]
  onSearch: (q: string) => void
  onSelect: (type_id: number, name: string) => void
  onSelectByproduct?: (type_id: number, name: string) => void
  onClose: () => void
  placeholder?: string
  showByproduct?: boolean
}) {
  return (
    <div className="mb-3 bg-canvas border border-wire rounded-lg p-3 space-y-2">
      <div className="flex gap-2">
        <input
          autoFocus
          value={value}
          onChange={e => onSearch(e.target.value)}
          className="flex-1 bg-surface border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
          placeholder={placeholder ?? 'Search item…'}
        />
        <button onClick={onClose} className="text-faint hover:text-primary text-[12px] px-2">
          Cancel
        </button>
      </div>
      {results.length > 0 && (
        <div className="max-h-48 overflow-y-auto border border-wire rounded divide-y divide-wire">
          {results.map(r => (
            <div key={r.type_id} className="flex items-center justify-between px-3 py-1.5 hover:bg-surface-hi">
              <span className="text-[13px] text-primary">{r.name}</span>
              <div className="flex gap-2">
                <button onClick={() => onSelect(r.type_id, r.name)}
                        className="text-[11px] text-accent hover:underline">
                  {showByproduct ? 'Add as Output' : 'Add'}
                </button>
                {showByproduct && onSelectByproduct && (
                  <button onClick={() => onSelectByproduct(r.type_id, r.name)}
                          className="text-[11px] text-muted hover:text-primary hover:underline">
                    Add as Byproduct
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
