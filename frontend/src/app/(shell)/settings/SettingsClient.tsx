'use client'

import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { LocationsTab } from './LocationsTab'
import { FreightRoutesTab } from './FreightRoutesTab'
import { EsiAuthTab } from './EsiAuthTab'
import { GeneralTab } from './GeneralTab'

const TABS = [
  { key: 'general',        label: 'General' },
  { key: 'locations',      label: 'Locations' },
  { key: 'freight-routes', label: 'Freight Routes' },
  { key: 'esi',            label: 'ESI / Auth' },
]

export function SettingsClient() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const active = searchParams.get('tab') ?? 'general'

  function setTab(key: string) {
    const p = new URLSearchParams(searchParams)
    p.set('tab', key)
    router.replace(`${pathname}?${p}`)
  }

  return (
    <div className="max-w-4xl">
      {/* Tab bar */}
      <div className="flex border-b border-wire mb-6">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setTab(tab.key)}
            className={[
              'px-4 py-2.5 text-[13px] font-medium -mb-px border-b-2 transition-colors',
              active === tab.key
                ? 'border-accent text-primary'
                : 'border-transparent text-muted hover:text-secondary',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {active === 'general'        && <GeneralTab />}
      {active === 'locations'      && <LocationsTab />}
      {active === 'freight-routes' && <FreightRoutesTab />}
      {active === 'esi'            && <EsiAuthTab />}
    </div>
  )
}
