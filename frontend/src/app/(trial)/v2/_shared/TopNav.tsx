'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/v2', label: 'Dashboard', exact: true },
  { href: '/v2/doctrines', label: 'Doctrines' },
  { href: '/v2/buying', label: 'Buying' },
  { href: '/v2/inventory', label: 'Inventory' },
  { href: '/v2/industry', label: 'Industry' },
  { href: '/v2/market-orders', label: 'Market orders' },
  { href: '/v2/contracts', label: 'Contracts' },
  { href: '/v2/mercenary', label: 'Mercenary dens' },
]

export function TopNav() {
  const pathname = usePathname()
  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`)

  return (
    <nav className="v2-bar-links" aria-label="Main">
      {LINKS.map(l => (
        <Link key={l.href} href={l.href} aria-current={isActive(l.href, l.exact) ? 'page' : undefined}>
          {l.label}
        </Link>
      ))}
      <Link href="/v2/settings" className="v2-classic" aria-current={isActive('/v2/settings') ? 'page' : undefined}>
        Settings
      </Link>
      <Link href="/">Classic view</Link>
    </nav>
  )
}
