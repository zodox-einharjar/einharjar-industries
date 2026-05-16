import { Suspense } from 'react'
import type { Metadata } from 'next'
import { DashboardClient } from './DashboardClient'

export const metadata: Metadata = { title: 'Dashboard' }

export default function DashboardPage() {
  return (
    <Suspense>
      <DashboardClient />
    </Suspense>
  )
}
