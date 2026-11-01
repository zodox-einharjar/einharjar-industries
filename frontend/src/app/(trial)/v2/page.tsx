import type { Metadata } from 'next'
import { TrialDashboard } from './TrialDashboard'

export const metadata: Metadata = { title: 'Dashboard (trial)' }

export default function TrialDashboardPage() {
  return <TrialDashboard />
}
