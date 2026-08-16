import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ImportRecommendationsClient } from './ImportRecommendationsClient'

export const metadata: Metadata = { title: 'Import Recommendations' }

export default function ImportRecommendationsPage() {
  return (
    <Suspense>
      <ImportRecommendationsClient />
    </Suspense>
  )
}
