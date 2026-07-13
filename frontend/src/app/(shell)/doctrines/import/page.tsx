import type { Metadata } from 'next'
import { Suspense } from 'react'
import { DoctrineImportClient } from './DoctrineImportClient'

export const metadata: Metadata = { title: 'Bulk Import Doctrines' }

export default function DoctrineImportPage() {
  return (
    <Suspense>
      <DoctrineImportClient />
    </Suspense>
  )
}
