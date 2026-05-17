import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ItemsClient } from './ItemsClient'

export const metadata: Metadata = { title: 'Items' }

export default function ItemsPage() {
  return (
    <Suspense>
      <ItemsClient />
    </Suspense>
  )
}
