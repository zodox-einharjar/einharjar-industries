'use client'

import { usePathname } from 'next/navigation'
import { useState, useEffect } from 'react'
import { useTopbarActions } from '@/lib/topbar-context'

const TITLES: Record<string, string> = {
  '/':              'Dashboard',
  '/availability':  'Doctrines',
  '/doctrines':     'Doctrines',
  '/fits':          'Fits',
  '/items':         'Items',
  '/industry':      'Industry',
  '/market-orders': 'Market Orders',
  '/contracts':     'Contracts',
  '/inventory':     'Inventory',
  '/pnl':           'History',
  '/settings':      'Settings',
}

function PollTimer() {
  const [nextPoll, setNextPoll] = useState<Date | null>(null)
  const [overdue, setOverdue]   = useState(false)
  const [secsLeft, setSecsLeft] = useState<number | null>(null)
  const [ready, setReady]       = useState(false)

  useEffect(() => {
    async function fetchStatus() {
      try {
        const r = await fetch('/api/poll-status')
        if (!r.ok) return
        const d = await r.json()
        setNextPoll(d.next_poll ? new Date(d.next_poll) : null)
        if (d.last_poll) {
          const ageMin = (Date.now() - new Date(d.last_poll).getTime()) / 60000
          setOverdue(ageMin > 15)
        } else {
          setOverdue(true)
        }
        setReady(true)
      } catch {}
    }
    fetchStatus()
    const id = setInterval(fetchStatus, 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!nextPoll) return
    function tick() {
      setSecsLeft(Math.max(0, Math.ceil((nextPoll!.getTime() - Date.now()) / 1000)))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [nextPoll])

  if (!ready) return null

  const dotColor = overdue ? 'bg-eve-amber' : 'bg-eve-green'

  let label: string
  if (secsLeft === null || secsLeft <= 0) {
    label = 'ESI polling…'
  } else {
    const mins = Math.floor(secsLeft / 60)
    const secs = secsLeft % 60
    label = `ESI poll in ${mins}:${String(secs).padStart(2, '0')}`
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
      <span className="text-[11px] font-mono text-faint">{label}</span>
    </div>
  )
}

export function Topbar() {
  const pathname = usePathname()
  const base = pathname === '/' ? '/' : '/' + pathname.split('/')[1]
  const title = TITLES[base] ?? 'Einharjar Industries'
  const { actions } = useTopbarActions()

  return (
    <header className="h-11 flex-shrink-0 flex items-center px-6 border-b border-wire bg-surface gap-4">
      <span className="text-[13px] font-medium text-primary">{title}</span>
      <div className="ml-auto flex items-center gap-4">
        <PollTimer />
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}
