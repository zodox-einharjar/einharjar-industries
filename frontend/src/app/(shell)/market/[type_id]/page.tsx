import { apiFetch } from '@/lib/api'
import { notFound } from 'next/navigation'
import { MarketDetailClient } from './MarketDetailClient'

export const metadata = { title: 'Market Item' }

export default async function MarketDetailPage({ params }: { params: { type_id: string } }) {
  const [itemRes, locRes] = await Promise.all([
    apiFetch(`/market-watch/${params.type_id}`),
    apiFetch('/locations'),
  ])

  if (!itemRes.ok) notFound()

  const item = await itemRes.json()
  const locations = locRes.ok ? await locRes.json() : []

  return <MarketDetailClient initialItem={item} locations={locations} />
}
