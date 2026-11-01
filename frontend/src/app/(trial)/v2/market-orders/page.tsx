import type { Metadata } from 'next'
import { MarketOrdersClient } from '../../../(shell)/market-orders/MarketOrdersClient'
import { PageHead } from '../_shared/PageHead'

export const metadata: Metadata = { title: 'Market orders (trial)' }

export default function TrialMarketOrdersPage() {
  return (
    <>
      <PageHead title="Market orders" />
      <div className="v2-port"><MarketOrdersClient /></div>
    </>
  )
}
