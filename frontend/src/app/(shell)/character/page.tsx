import type { Metadata } from 'next'
import { Suspense } from 'react'
import { CharacterClient } from './CharacterClient'

export const metadata: Metadata = { title: 'Character' }

export default function CharacterPage() {
  return (
    <Suspense>
      <CharacterClient />
    </Suspense>
  )
}
