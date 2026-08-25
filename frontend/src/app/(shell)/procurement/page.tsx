import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ProcurementClient } from './ProcurementClient'

export const metadata: Metadata = { title: 'Procurement' }

export default function ProcurementPage() {
  return (
    <Suspense>
      <ProcurementClient />
    </Suspense>
  )
}
