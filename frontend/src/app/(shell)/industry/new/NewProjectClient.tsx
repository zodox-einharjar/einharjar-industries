'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

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

interface Location {
  id: number
  name: string
}

export function NewProjectClient({ locations }: { locations: Location[] }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeJobCat, setActiveJobCat] = useState(CATEGORIES[0])
  const [jobTexts, setJobTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(CATEGORIES.map(c => [c, '']))
  )
  const [materialsText, setMaterialsText] = useState('')
  const [outputsText, setOutputsText] = useState('')

  function parseIsk(s: string): number {
    return parseFloat(s.replace(/[\s,]/g, '')) || 0
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true)
    setError(null)

    const fd = new FormData(e.currentTarget)
    const body = {
      name: fd.get('name') as string,
      ravworks_url: (fd.get('ravworks_url') as string) || null,
      invention_cost: parseIsk(fd.get('invention_cost') as string),
      blueprint_cost: parseIsk(fd.get('blueprint_cost') as string),
      extra_cost: parseIsk(fd.get('extra_cost') as string),
      target_margin_pct: fd.get('target_margin_pct')
        ? parseFloat(fd.get('target_margin_pct') as string)
        : null,
      output_location_id: fd.get('output_location_id')
        ? parseInt(fd.get('output_location_id') as string)
        : null,
    }

    // 1. Create project
    const res = await fetch('/api/industry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      setError(err.detail ?? 'Failed to create project')
      setSaving(false)
      return
    }

    const project = await res.json()
    const id = project.id
    const warnings: string[] = []

    // 2. Paste materials table
    if (materialsText.trim()) {
      const r = await fetch(`/api/industry/${id}/materials/paste`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: materialsText }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        warnings.push(`Materials: ${err.detail ?? 'parse error'}`)
      } else {
        const d = await r.json()
        if (d.skipped?.length) warnings.push(`Materials: ${d.skipped.length} unknown item(s) skipped`)
      }
    }

    // 3. Paste outputs table
    if (outputsText.trim()) {
      const r = await fetch(`/api/industry/${id}/outputs/paste`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: outputsText }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        warnings.push(`Outputs: ${err.detail ?? 'parse error'}`)
      } else {
        const d = await r.json()
        if (d.skipped?.length) warnings.push(`Outputs: ${d.skipped.length} unknown item(s) skipped`)
      }
    }

    // 4. Paste jobs per category
    for (const [category, text] of Object.entries(jobTexts)) {
      if (!text.trim()) continue
      const r = await fetch(`/api/industry/${id}/jobs/paste`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, text }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        warnings.push(`${category}: ${err.detail?.errors?.join(', ') ?? 'parse error'}`)
      }
    }

    if (warnings.length > 0) {
      setError('Project created with warnings:\n' + warnings.join('\n'))
    }

    router.push(`/industry/${id}`)
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold text-primary mb-6">New Industry Project</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-[13px] whitespace-pre-line">
            {error}
          </div>
        )}

        {/* General */}
        <div className="bg-surface border border-wire rounded-lg p-4 space-y-4">
          <div className="text-[11px] font-semibold tracking-widest text-faint uppercase">General</div>

          <div>
            <label className="block text-[12px] text-muted mb-1">Project Name</label>
            <input name="name" required
              className="w-full bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
              placeholder="e.g. Ishtar batch" />
          </div>

          <div>
            <label className="block text-[12px] text-muted mb-1">Ravworks URL</label>
            <input name="ravworks_url" type="url"
              className="w-full bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
              placeholder="https://ravworks.com/..." />
          </div>

          <div>
            <label className="block text-[12px] text-muted mb-1">Output Location</label>
            <select name="output_location_id"
              className="w-full bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent">
              <option value="">— Select location —</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        </div>

        {/* Costs */}
        <div className="bg-surface border border-wire rounded-lg p-4 space-y-4">
          <div className="text-[11px] font-semibold tracking-widest text-faint uppercase">Costs</div>

          <div className="grid grid-cols-2 gap-4">
            <CostField name="invention_cost" label="Invention Cost" />
            <CostField name="blueprint_cost" label="Blueprint Cost" />
            <CostField name="extra_cost" label="Extra Cost" />
          </div>

          <div>
            <label className="block text-[12px] text-muted mb-1">Target Margin %</label>
            <input name="target_margin_pct" type="number" step="0.1" min="0"
              className="w-40 bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
              placeholder="e.g. 15" />
          </div>
        </div>

        {/* Materials */}
        <div className="bg-surface border border-wire rounded-lg p-4">
          <div className="text-[11px] font-semibold tracking-widest text-faint uppercase mb-1">
            Materials
          </div>
          <p className="text-[11px] text-faint mb-3">
            Paste the materials table from Ravworks. Items with <em>To Buy &gt; 0</em> become inputs; items with <em>End Amount &gt; 0</em> become byproducts.
          </p>
          <textarea
            value={materialsText}
            onChange={e => setMaterialsText(e.target.value)}
            rows={6}
            className="w-full bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary focus:outline-none focus:border-accent resize-y"
            placeholder={"Name\tTo Buy\tTo Buy (Sell-Value)\tTo Buy Volume\tStart Amount\tEnd Amount\nTritanium\t4861001\t…"}
          />
        </div>

        {/* Outputs */}
        <div className="bg-surface border border-wire rounded-lg p-4">
          <div className="text-[11px] font-semibold tracking-widest text-faint uppercase mb-1">
            Outputs
          </div>
          <p className="text-[11px] text-faint mb-3">
            Paste the output table from Ravworks.
          </p>
          <textarea
            value={outputsText}
            onChange={e => setOutputsText(e.target.value)}
            rows={4}
            className="w-full bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary focus:outline-none focus:border-accent resize-y"
            placeholder={"Name\tAmount\tVolume\tSell Price/Unit\tSell Price\nIshtar\t10\t…"}
          />
        </div>

        {/* Jobs */}
        <div className="bg-surface border border-wire rounded-lg p-4">
          <div className="text-[11px] font-semibold tracking-widest text-faint uppercase mb-3">
            Jobs <span className="text-faint font-normal normal-case">(optional — can be added later)</span>
          </div>

          <div className="flex flex-wrap gap-1 mb-3">
            {CATEGORIES.map(cat => {
              const hasContent = jobTexts[cat].trim().length > 0
              return (
                <button key={cat} type="button" onClick={() => setActiveJobCat(cat)}
                  className={[
                    'px-2.5 py-1 text-[11px] rounded border transition-colors',
                    activeJobCat === cat
                      ? 'border-accent text-accent bg-accent/10'
                      : hasContent
                      ? 'border-wire text-primary bg-surface-hi'
                      : 'border-wire text-faint hover:text-muted',
                  ].join(' ')}>
                  {cat}{hasContent && <span className="ml-1 text-accent">•</span>}
                </button>
              )
            })}
          </div>

          <textarea
            key={activeJobCat}
            value={jobTexts[activeJobCat]}
            onChange={e => setJobTexts(prev => ({ ...prev, [activeJobCat]: e.target.value }))}
            rows={7}
            className="w-full bg-canvas border border-wire rounded px-3 py-2 text-[12px] font-mono text-primary focus:outline-none focus:border-accent resize-y"
            placeholder={"Name\tRuns\tDays\tJob Cost\nVexor Blueprint\t1\t0.09\t1,290,525"}
          />
          <div className="text-[11px] text-faint mt-1">
            Paste from Ravworks for: <span className="text-muted">{activeJobCat}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={saving}
            className="px-4 py-2 text-[13px] bg-accent text-canvas rounded hover:bg-accent/90 disabled:opacity-50 transition-colors">
            {saving ? 'Creating…' : 'Create Project'}
          </button>
          <button type="button" onClick={() => router.back()}
            className="px-4 py-2 text-[13px] text-muted hover:text-primary transition-colors">
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

function CostField({ name, label }: { name: string; label: string }) {
  return (
    <div>
      <label className="block text-[12px] text-muted mb-1">{label}</label>
      <input name={name} type="text" inputMode="numeric" defaultValue="0"
        className="w-full bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
        placeholder="0" />
    </div>
  )
}
