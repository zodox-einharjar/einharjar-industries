import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ReprocessingClient } from './ReprocessingClient'

export const metadata: Metadata = { title: 'Reprocessing' }

export default function ReprocessingPage() {
  return (
    <Suspense>
      <ReprocessingClient />
    </Suspense>
  )
}
