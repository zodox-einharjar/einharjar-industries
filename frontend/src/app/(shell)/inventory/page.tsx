import { Suspense } from 'react'
import type { Metadata } from 'next'
import { InventoryClient } from './InventoryClient'

export const metadata: Metadata = { title: 'Inventory' }

export default function InventoryPage() {
  return (
    <Suspense>
      <InventoryClient />
    </Suspense>
  )
}
