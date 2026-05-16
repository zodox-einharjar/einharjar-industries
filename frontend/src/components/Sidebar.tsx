'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

interface User {
  character_id: number
  character_name: string
  corp_name: string | null
  portrait_url: string
}

function HexLogo() {
  return (
    <svg width="26" height="30" viewBox="0 0 26 30" fill="none">
      <path
        d="M13 1.5L24.5 8V22L13 28.5L1.5 22V8L13 1.5Z"
        fill="var(--accent)"
        fillOpacity="0.12"
        stroke="var(--accent)"
        strokeWidth="1.5"
      />
      <path
        d="M13 8.5L19.5 12.25V19.75L13 23.5L6.5 19.75V12.25L13 8.5Z"
        fill="var(--accent)"
      />
    </svg>
  )
}

function BelowTargetBadge() {
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/doctrines/below-target')
      .then(r => (r.ok ? r.json() : null))
      .then(d => d != null && setCount(d.count))
      .catch(() => {})
  }, [])

  if (!count) return null

  return (
    <span className="ml-auto text-[10px] font-semibold bg-eve-amber text-canvas rounded-full px-1.5 leading-[18px] min-w-[18px] text-center">
      {count}
    </span>
  )
}

const NAV = [
  {
    items: [{ label: 'Dashboard', href: '/' }],
  },
  {
    label: 'Fleet',
    items: [
      { label: 'Doctrines', href: '/availability', badge: <BelowTargetBadge /> },
    ],
  },
  {
    label: 'Industry',
    items: [{ label: 'Projects', href: '/industry' }],
  },
  {
    label: 'Market',
    items: [
      { label: 'Market Orders', href: '/market-orders' },
      { label: 'Contracts', href: '/contracts' },
      { label: 'Inventory', href: '/inventory' },
      { label: 'History', href: '/pnl' },
    ],
  },
  {
    label: 'Config',
    items: [{ label: 'Settings', href: '/settings' }],
  },
]

export function Sidebar({ user }: { user: User }) {
  const pathname = usePathname()

  const isActive = (href: string) =>
    href === '/'
      ? pathname === '/'
      : pathname === href || pathname.startsWith(href + '/')

  return (
    <aside className="w-[180px] flex-shrink-0 h-full bg-surface border-r border-wire flex flex-col">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-5 border-b border-wire">
        <HexLogo />
        <div className="leading-tight">
          <div className="text-[10px] font-bold tracking-[0.12em] text-primary uppercase">
            Einharjar
          </div>
          <div className="text-[10px] font-bold tracking-[0.12em] text-muted uppercase">
            Industries
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 overflow-y-auto">
        {NAV.map((group, gi) => (
          <div key={gi} className={gi > 0 ? 'mt-4' : ''}>
            {group.label && (
              <div className="px-4 pb-1 text-[10px] font-semibold tracking-[0.12em] text-faint uppercase">
                {group.label}
              </div>
            )}
            {group.items.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className={[
                  'flex items-center px-4 py-1.5 text-[13px] transition-colors',
                  isActive(item.href)
                    ? 'bg-surface-hi text-primary'
                    : 'text-secondary hover:text-primary hover:bg-surface-hi',
                ].join(' ')}
              >
                {item.label}
                {'badge' in item ? item.badge : null}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      {/* Character */}
      <div className="border-t border-wire px-3 py-3 flex items-center gap-2.5 min-w-0">
        <Image
          src={user.portrait_url}
          alt={user.character_name}
          width={32}
          height={32}
          className="rounded flex-shrink-0"
          unoptimized
        />
        <div className="min-w-0">
          <div className="text-[13px] text-primary font-medium truncate">
            {user.character_name}
          </div>
          <div className="text-[11px] text-muted truncate">
            {user.corp_name ?? '—'}
          </div>
        </div>
      </div>
    </aside>
  )
}
