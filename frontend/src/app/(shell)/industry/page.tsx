import { apiFetch } from '@/lib/api'
import { IndustryClient } from './IndustryClient'

export const metadata = { title: 'Industry' }

export default async function IndustryPage() {
  const res = await apiFetch('/industry')
  const projects = res.ok ? await res.json() : []
  return <IndustryClient initialProjects={projects} />
}
