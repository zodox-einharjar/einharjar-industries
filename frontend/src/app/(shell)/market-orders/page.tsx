import type { Metadata } from 'next'
import { MarketOrdersClient } from './MarketOrdersClient'

export const metadata: Metadata = { title: 'Market Orders' }

export default function MarketOrdersPage() {
  return <MarketOrdersClient />
}
