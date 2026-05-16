import type { Metadata } from 'next'
import { FitDetailClient } from './FitDetailClient'

export const metadata: Metadata = { title: 'Fit' }

export default function FitDetailPage({
  params,
  searchParams,
}: {
  params: { id: string }
  searchParams: { from?: string }
}) {
  return <FitDetailClient id={+params.id} fromDoctrineId={searchParams.from ? +searchParams.from : null} />
}
