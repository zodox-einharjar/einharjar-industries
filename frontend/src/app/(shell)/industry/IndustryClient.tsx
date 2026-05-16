'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

interface Project {
  id: number
  name: string
  status: 'planning' | 'in_progress' | 'complete'
  total_job_cost: number
  target_margin_pct: number | null
  output_location_name: string | null
  created_at: string
  completed_at: string | null
  materials: { quantity_needed: number; quantity_reserved: number }[]
  outputs: { is_byproduct: boolean }[]
}

const STATUS_LABEL: Record<string, string> = {
  planning: 'Planning',
  in_progress: 'In Progress',
  complete: 'Complete',
}

const STATUS_COLOR: Record<string, string> = {
  planning: 'bg-eve-amber/15 text-eve-amber',
  in_progress: 'bg-accent/15 text-accent',
  complete: 'bg-green-500/15 text-green-400',
}

function isk(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}b`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return n.toLocaleString()
}

export function IndustryClient({ initialProjects }: { initialProjects: Project[] }) {
  const router = useRouter()
  const [projects, setProjects] = useState(initialProjects)

  async function deleteProject(id: number) {
    if (!confirm('Delete this project?')) return
    const res = await fetch(`/api/industry/${id}`, { method: 'DELETE' })
    if (res.ok) setProjects(p => p.filter(x => x.id !== id))
  }

  const active = projects.filter(p => p.status !== 'complete')
  const completed = projects.filter(p => p.status === 'complete')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-primary">Industry Projects</h1>
        <Link
          href="/industry/new"
          className="px-3 py-1.5 text-[13px] bg-accent text-canvas rounded hover:bg-accent/90 transition-colors"
        >
          New Project
        </Link>
      </div>

      {projects.length === 0 && (
        <div className="text-center py-16 text-muted text-[13px]">
          No projects yet.{' '}
          <Link href="/industry/new" className="text-accent hover:underline">
            Create your first project
          </Link>
        </div>
      )}

      {active.length > 0 && (
        <section>
          <ProjectTable projects={active} onDelete={deleteProject} />
        </section>
      )}

      {completed.length > 0 && (
        <section>
          <div className="text-[11px] font-semibold tracking-widest text-faint uppercase mb-2">
            Completed
          </div>
          <ProjectTable projects={completed} onDelete={deleteProject} />
        </section>
      )}
    </div>
  )
}

function ProjectTable({
  projects,
  onDelete,
}: {
  projects: Project[]
  onDelete: (id: number) => void
}) {
  return (
    <div className="bg-surface border border-wire rounded-lg overflow-hidden">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-wire text-faint text-[11px] uppercase tracking-wider">
            <th className="text-left px-4 py-2">Project</th>
            <th className="text-left px-4 py-2">Status</th>
            <th className="text-right px-4 py-2">Job Costs</th>
            <th className="text-right px-4 py-2">Margin</th>
            <th className="text-left px-4 py-2">Output Location</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {projects.map(p => (
            <tr key={p.id} className="border-b border-wire last:border-0 hover:bg-surface-hi">
              <td className="px-4 py-3">
                <Link href={`/industry/${p.id}`} className="text-accent hover:underline font-medium">
                  {p.name}
                </Link>
                <div className="text-[11px] text-faint mt-0.5">
                  {p.materials.length} material{p.materials.length !== 1 ? 's' : ''} ·{' '}
                  {p.outputs.filter(o => !o.is_byproduct).length} output
                  {p.outputs.filter(o => !o.is_byproduct).length !== 1 ? 's' : ''}
                </div>
              </td>
              <td className="px-4 py-3">
                <span
                  className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${STATUS_COLOR[p.status]}`}
                >
                  {STATUS_LABEL[p.status]}
                </span>
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {p.total_job_cost > 0 ? isk(p.total_job_cost) : '—'}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-muted">
                {p.target_margin_pct != null ? `${p.target_margin_pct}%` : '—'}
              </td>
              <td className="px-4 py-3 text-muted">
                {p.output_location_name ?? '—'}
              </td>
              <td className="px-4 py-3 text-right">
                <button
                  onClick={() => onDelete(p.id)}
                  className="text-faint hover:text-red-400 transition-colors text-[11px]"
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
