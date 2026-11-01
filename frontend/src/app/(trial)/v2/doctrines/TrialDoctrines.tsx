'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DoctrineCard, DoctrineReport, MarketFreshness, StatusLegend, fitFill, sortDoctrines,
} from '../_shared/doctrines'

type Filter = 'all' | 'below' | 'ready'

export function TrialDoctrines() {
  const [report, setReport] = useState<DoctrineReport | null>(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const load = useCallback(() => {
    fetch('/api/dashboard')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(r => { setReport(r); setFailed(false) })
      .catch(() => setFailed(true))
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  // Once loaded, scroll to a doctrine linked from a dashboard tile.
  useEffect(() => {
    if (report && window.location.hash) {
      document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: 'start' })
    }
  }, [report])

  const doctrines = useMemo(() => sortDoctrines(report?.doctrine_summary ?? []), [report])
  const belowCount = doctrines.filter(d => d.status !== 'ready' && d.status !== 'unknown').length
  const readyCount = doctrines.filter(d => d.status === 'ready').length

  // A doctrine matches if its own name or location matches (all fits shown), or if
  // any of its fits match (only those fits shown).
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return doctrines
      .filter(d => filter === 'all' || (filter === 'ready' ? d.status === 'ready' : d.status !== 'ready' && d.status !== 'unknown'))
      .map(d => {
        let fits = d.fits
        if (filter === 'below') fits = fits.filter(f => fitFill(f) < 1)
        if (!q) return { d, fits }
        const docHit = d.name.toLowerCase().includes(q) || (d.location_name ?? '').toLowerCase().includes(q)
        if (docHit) return { d, fits }
        const hits = fits.filter(f =>
          f.name.toLowerCase().includes(q)
          || (f.ship_name ?? '').toLowerCase().includes(q)
          || (f.limiting_item ?? '').toLowerCase().includes(q))
        return hits.length ? { d, fits: hits } : null
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
  }, [doctrines, query, filter])

  return (
    <section aria-labelledby="doctrines-title">
      <div className="v2-board-head">
        <h2 id="doctrines-title">Doctrines</h2>
        {report && (
          <p>
            {report.doctrines_fully_stocked} of {report.doctrine_count} doctrines at target.{' '}
            <MarketFreshness lastPoll={report.last_poll} />
          </p>
        )}
        <Link href="/doctrines">Edit doctrines and fits</Link>
        <Link href="/shopping">Build a shopping list</Link>
      </div>

      <div className="v2-filters">
        <input
          type="search"
          className="v2-search"
          placeholder="Search doctrines, fits, ships or items"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search doctrines, fits, ships or items"
        />
        <button className="v2-chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          All<small>{doctrines.length}</small>
        </button>
        <button className="v2-chip" aria-pressed={filter === 'below'} onClick={() => setFilter('below')}>
          Below target<small>{belowCount}</small>
        </button>
        <button className="v2-chip" aria-pressed={filter === 'ready'} onClick={() => setFilter('ready')}>
          At target<small>{readyCount}</small>
        </button>
      </div>

      <StatusLegend />

      {failed && !report ? (
        <p className="v2-calm">The doctrines couldn&apos;t be loaded. Check that the backend is running, then reload.</p>
      ) : !report ? (
        <div className="v2-skeleton" aria-busy="true" />
      ) : doctrines.length === 0 ? (
        <p className="v2-empty">
          No doctrines yet. <Link href="/doctrines" style={{ color: 'var(--brass)' }}>Add your first doctrine</Link> to track its stock here.
        </p>
      ) : visible.length === 0 ? (
        <p className="v2-empty">
          Nothing matches{query ? ` “${query}”` : ''}{filter !== 'all' ? ' with this filter' : ''}.{' '}
          <button className="v2-chip" onClick={() => { setQuery(''); setFilter('all') }}>Clear search and filter</button>
        </p>
      ) : (
        <div className="v2-board">
          {visible.map(({ d, fits }, i) => <DoctrineCard key={d.id} d={d} index={i} fits={fits} />)}
        </div>
      )}
    </section>
  )
}
