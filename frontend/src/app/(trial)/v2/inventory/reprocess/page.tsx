import type { Metadata } from 'next'
import { ReprocessInventoryTab } from '../../../../(shell)/reprocessing/ReprocessingClient'
import { PageHead } from '../../_shared/PageHead'
import { INVENTORY_TABS } from '../tabs'

export const metadata: Metadata = { title: 'Reprocess inventory (trial)' }

export default function TrialInventoryReprocessPage() {
  return (
    <>
      <PageHead title="Inventory" tabs={INVENTORY_TABS} />
      <div className="v2-port"><ReprocessInventoryTab /></div>
    </>
  )
}
