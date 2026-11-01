import type { Metadata } from 'next'
import ClassicIndustryPage from '../../../(shell)/industry/page'
import { PageHead } from '../_shared/PageHead'
import { INDUSTRY_TABS } from './tabs'

export const metadata: Metadata = { title: 'Industry (trial)' }

export default async function TrialIndustryPage() {
  return (
    <>
      <PageHead title="Industry" tabs={INDUSTRY_TABS} />
      <div className="v2-port"><ClassicIndustryPage /></div>
    </>
  )
}
