import type { Metadata } from 'next'
import ClassicNewProjectPage from '../../../../(shell)/industry/new/page'
import { PageHead } from '../../_shared/PageHead'
import { INDUSTRY_TABS } from '../tabs'

export const metadata: Metadata = { title: 'New industry project (trial)' }

export default async function TrialNewProjectPage() {
  return (
    <>
      <PageHead title="New project" tabs={INDUSTRY_TABS} />
      <div className="v2-port"><ClassicNewProjectPage /></div>
    </>
  )
}
