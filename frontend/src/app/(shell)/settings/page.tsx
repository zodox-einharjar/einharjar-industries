import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SettingsClient } from './SettingsClient'

export const metadata: Metadata = { title: 'Settings' }

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsClient />
    </Suspense>
  )
}
