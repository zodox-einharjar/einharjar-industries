import type { Metadata } from 'next'
import { Suspense } from 'react'
import { FitsClient } from './FitsClient'

export const metadata: Metadata = { title: 'Fits' }

export default function FitsPage() {
  return (
    <Suspense>
      <FitsClient />
    </Suspense>
  )
}
