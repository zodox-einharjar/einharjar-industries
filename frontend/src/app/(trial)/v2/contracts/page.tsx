import type { Metadata } from 'next'
import { ContractsClient } from '../../../(shell)/contracts/ContractsClient'
import { PageHead } from '../_shared/PageHead'

export const metadata: Metadata = { title: 'Contracts (trial)' }

export default function TrialContractsPage() {
  return (
    <>
      <PageHead title="Contracts" />
      <div className="v2-port"><ContractsClient /></div>
    </>
  )
}
