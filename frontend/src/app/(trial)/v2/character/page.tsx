import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CharacterClient } from '../../../(shell)/character/CharacterClient'
import { PageHead } from '../_shared/PageHead'

export const metadata: Metadata = { title: 'Character (trial)' }

export default function TrialCharacterPage() {
  return (
    <>
      <PageHead title="Character" />
      <div className="v2-port"><Suspense><CharacterClient /></Suspense></div>
    </>
  )
}
