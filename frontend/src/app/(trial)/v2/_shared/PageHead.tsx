'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { useTopbarActions } from '@/lib/topbar-context'

/** Heading for trial pages that reuse classic page components: shows the title,
 *  optional sub-page tabs, and any buttons the page puts in the "topbar" slot. */
export function PageHead({ title, tabs, children }: {
  title: string
  tabs?: { href: string; label: string; exact?: boolean }[]
  children?: ReactNode
}) {
  const { actions } = useTopbarActions()
  const pathname = usePathname()
  return (
    <div className="v2-board-head v2-pagehead">
      <h2>{title}</h2>
      {tabs && (
        <nav className="v2-tabs" aria-label={`${title} sections`}>
          {tabs.map(t => {
            const on = t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`)
            return <Link key={t.href} href={t.href} aria-current={on ? 'page' : undefined}>{t.label}</Link>
          })}
        </nav>
      )}
      {children}
      {actions && <div className="v2-pagehead-actions">{actions}</div>}
    </div>
  )
}
