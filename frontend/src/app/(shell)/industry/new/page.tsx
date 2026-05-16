import { apiFetch } from '@/lib/api'
import { NewProjectClient } from './NewProjectClient'

export const metadata = { title: 'New Industry Project' }

export default async function NewProjectPage() {
  const res = await apiFetch('/locations')
  const locations = res.ok ? await res.json() : []
  return <NewProjectClient locations={locations} />
}
