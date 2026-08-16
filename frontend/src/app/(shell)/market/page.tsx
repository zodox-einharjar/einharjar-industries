import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MarketWatchClient } from './MarketWatchClient'

export const metadata: Metadata = { title: 'Watchlist' }

export default function MarketWatchPage() {
  return (
    <Suspense>
      <MarketWatchClient />
    </Suspense>
  )
}
