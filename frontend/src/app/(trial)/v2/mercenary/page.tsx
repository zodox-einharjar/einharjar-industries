import type { Metadata } from 'next'
import { MercenaryClient } from '../../../(shell)/mercenary/MercenaryClient'
import { PageHead } from '../_shared/PageHead'

export const metadata: Metadata = { title: 'Mercenary dens (trial)' }

export default function TrialMercenaryPage() {
  return (
    <>
      <PageHead title="Mercenary dens" />
      <div className="v2-port"><MercenaryClient /></div>
    </>
  )
}
