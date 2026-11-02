import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { apiFetch } from '@/lib/api'
import { TrialItem } from './TrialItem'

export async function generateMetadata({ params }: { params: { type_id: string } }): Promise<Metadata> {
  const r = await apiFetch(`/items/${params.type_id}`)
  const name = r.ok ? (await r.json()).name : 'Item'
  return { title: `${name} (trial)` }
}

export default async function TrialItemPage({ params }: { params: { type_id: string } }) {
  if (!/^\d+$/.test(params.type_id)) notFound()
  const [itemRes, marketRes, locRes] = await Promise.all([
    apiFetch(`/items/${params.type_id}`),
    apiFetch(`/market-watch/${params.type_id}`),
    apiFetch('/locations'),
  ])
  if (!itemRes.ok) notFound()

  return (
    <TrialItem
      key={params.type_id}
      item={await itemRes.json()}
      market={marketRes.ok ? await marketRes.json() : null}
      locations={locRes.ok ? await locRes.json() : []}
    />
  )
}
