import type { Metadata } from 'next'
import { JobsClient } from '../../../../(shell)/industry/jobs/JobsClient'
import { PageHead } from '../../_shared/PageHead'
import { INDUSTRY_TABS } from '../tabs'

export const metadata: Metadata = { title: 'Industry jobs (trial)' }

export default function TrialJobsPage() {
  return (
    <>
      <PageHead title="Industry" tabs={INDUSTRY_TABS} />
      <div className="v2-port"><JobsClient /></div>
    </>
  )
}
