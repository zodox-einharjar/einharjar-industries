'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Trial pages first; Industry and Market still go to the classic app until ported.
const LINKS = [
  { href: '/v2', label: 'Dashboard', exact: true },
  { href: '/v2/doctrines', label: 'Doctrines' },
  { href: '/v2/buying', label: 'Buying' },
  { href: '/industry', label: 'Industry' },
  { href: '/market-orders', label: 'Market' },
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
