import type { Metadata } from 'next'
import { Suspense } from 'react'
import { BuybackClient } from './BuybackClient'

export const metadata: Metadata = { title: 'Buyback' }

export default function BuybackPage() {
  return (
    <Suspense>
      <BuybackClient />
    </Suspense>
  )
}
