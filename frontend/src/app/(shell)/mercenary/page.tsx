import type { Metadata } from 'next'
import { Suspense } from 'react'
import { MercenaryClient } from './MercenaryClient'

export const metadata: Metadata = { title: 'Mercenary Dens' }

export default function MercenaryPage() {
  return (
    <Suspense>
      <MercenaryClient />
    </Suspense>
  )
}
