import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ShoppingClient } from './ShoppingClient'

export const metadata: Metadata = { title: 'Shopping' }

export default function ShoppingPage() {
  return (
    <Suspense>
      <ShoppingClient />
    </Suspense>
  )
}
