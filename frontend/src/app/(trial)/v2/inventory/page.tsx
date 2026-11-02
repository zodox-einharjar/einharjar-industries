import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InventoryClient } from '../../../(shell)/inventory/InventoryClient'
import { PageHead } from '../_shared/PageHead'
import { INVENTORY_TABS } from './tabs'

export const metadata: Metadata = { title: 'Inventory (trial)' }

export default function TrialInventoryPage() {
  return (
    <>
      <PageHead title="Inventory" tabs={INVENTORY_TABS} />
      <div className="v2-port"><Suspense><InventoryClient /></Suspense></div>
    </>
  )
}
