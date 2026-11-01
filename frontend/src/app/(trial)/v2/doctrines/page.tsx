import type { Metadata } from 'next'
import { TrialDoctrines } from './TrialDoctrines'

export const metadata: Metadata = { title: 'Doctrines (trial)' }

export default function TrialDoctrinesPage() {
  return <TrialDoctrines />
}
