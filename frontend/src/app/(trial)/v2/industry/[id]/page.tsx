import type { Metadata } from 'next'
import Link from 'next/link'
import ClassicProjectPage from '../../../../(shell)/industry/[id]/page'
import { PageHead } from '../../_shared/PageHead'
import { INDUSTRY_TABS } from '../tabs'

export const metadata: Metadata = { title: 'Industry project (trial)' }

export default async function TrialProjectPage({ params }: { params: { id: string } }) {
  return (
    <>
      <PageHead title="Project" tabs={INDUSTRY_TABS}>
        <Link href={`/v2/buying?projects=${params.id}`}>Buy what&apos;s missing</Link>
      </PageHead>
      <div className="v2-port"><ClassicProjectPage params={params} /></div>
    </>
  )
}
