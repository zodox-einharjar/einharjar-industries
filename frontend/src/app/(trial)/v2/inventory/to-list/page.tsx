import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PageHead } from '../../_shared/PageHead'
import { INVENTORY_TABS } from '../tabs'
import { ToListClient } from './ToListClient'

export const metadata: Metadata = { title: 'To list (trial)' }

export default function TrialToListPage() {
  return (
    <>
      <PageHead title="Inventory" tabs={INVENTORY_TABS} />
      <Suspense><ToListClient /></Suspense>
    </>
  )
}
