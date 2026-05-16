import { apiFetch } from '@/lib/api'
import { notFound } from 'next/navigation'
import { ProjectDetailClient } from './ProjectDetailClient'

export const metadata = { title: 'Industry Project' }

export default async function ProjectDetailPage({ params }: { params: { id: string } }) {
  const [projectRes, locRes] = await Promise.all([
    apiFetch(`/industry/${params.id}`),
    apiFetch('/locations'),
  ])

  if (!projectRes.ok) notFound()

  const project = await projectRes.json()
  const locations = locRes.ok ? await locRes.json() : []

  return <ProjectDetailClient project={project} locations={locations} />
}
