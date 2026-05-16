import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AvailabilityClient } from './AvailabilityClient'

export const metadata: Metadata = { title: 'Doctrines' }

export default function AvailabilityPage() {
  return (
    <Suspense>
      <AvailabilityClient />
    </Suspense>
  )
}
