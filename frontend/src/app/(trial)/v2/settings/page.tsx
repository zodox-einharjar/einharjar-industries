import type { Metadata } from 'next'
import { Suspense } from 'react'
import { TrialSettings } from './TrialSettings'

export const metadata: Metadata = { title: 'Settings (trial)' }

export default function TrialSettingsPage() {
  return (
    <Suspense>
      <TrialSettings />
    </Suspense>
  )
}
