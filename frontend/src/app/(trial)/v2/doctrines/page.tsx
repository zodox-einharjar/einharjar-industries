import type { Metadata } from 'next'
import { Suspense } from 'react'
import { TrialDoctrines } from './TrialDoctrines'

export const metadata: Metadata = { title: 'Doctrines (trial)' }

export default function TrialDoctrinesPage() {
  return (
    <Suspense>
      <TrialDoctrines />
    </Suspense>
  )
}
