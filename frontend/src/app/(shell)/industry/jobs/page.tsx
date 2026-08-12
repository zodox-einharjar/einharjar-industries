import type { Metadata } from 'next'
import { JobsClient } from './JobsClient'

export const metadata: Metadata = { title: 'Industry Jobs' }

export default function IndustryJobsPage() {
  return <JobsClient />
}
