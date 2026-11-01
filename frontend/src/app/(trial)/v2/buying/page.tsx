import type { Metadata } from 'next'
import { Suspense } from 'react'
import { TrialBuying } from './TrialBuying'

export const metadata: Metadata = { title: 'Buying (trial)' }

export default function TrialBuyingPage() {
  return (
    <Suspense>
      <TrialBuying />
    </Suspense>
  )
}
