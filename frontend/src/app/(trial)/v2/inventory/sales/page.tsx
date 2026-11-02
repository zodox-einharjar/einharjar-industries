import type { Metadata } from 'next'
import { PnlClient } from '../../../../(shell)/pnl/PnlClient'
import { PageHead } from '../../_shared/PageHead'
import { INVENTORY_TABS } from '../tabs'

export const metadata: Metadata = { title: 'Sales & P&L (trial)' }

export default function TrialInventorySalesPage() {
  return (
    <>
      <PageHead title="Inventory" tabs={INVENTORY_TABS} />
      <div className="v2-port"><PnlClient /></div>
    </>
  )
}
