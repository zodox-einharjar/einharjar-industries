import { Suspense } from 'react'
import { PnlClient } from './PnlClient'

export default function PnlPage() {
  return (
    <Suspense fallback={<div className="text-muted text-[13px]">Loading…</div>}>
      <PnlClient />
    </Suspense>
  )
}
