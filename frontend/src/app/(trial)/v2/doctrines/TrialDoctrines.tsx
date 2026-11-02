'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DoctrineCard, DoctrineReport, MarketFreshness, Selection, StatusLegend, TriCheckbox, fitFill, isk, sortDoctrines,
} from '../_shared/doctrines'
import { Th, useSort } from '../_shared/sort'

// ── Types for the per-fit and per-item endpoints ─────────────────────────────

interface FleetFit {
  fit_id: number
  fit_name: string
  hull: string
  doctrines: {
    doctrine_id: number
    doctrine_name: string
    df_id: number
    target_qty: number
    stock: number | null
    location_name: string | null
  }[]
}

interface FleetItem {
  type_id: number
  name: string
  location_name: string
  total_needed: number
  qty_available: number
  shortfall: number
  staging_price: number | null
  import_cost: number | null
  fits: { fit_id: number; fit_name: string; qty_per_fit: number; target: number }[]
}

type View = 'doctrines' | 'fits' | 'items'
type StockFilter = 'all' | 'below' | 'ready'

const VIEWS: { key: View; label: string }[] = [
  { key: 'doctrines', label: 'By doctrine' },
  { key: 'fits', label: 'By fit' },
  { key: 'items', label: 'By item' },
]

function tone(stock: number, target: number): 'is-ready' | 'is-partial' | 'is-short' {
  return stock >= target ? 'is-ready' : stock === 0 ? 'is-short' : 'is-partial'
}

function matches(q: string, ...fields: (string | null | undefined)[]): boolean {
  return fields.some(f => (f ?? '').toLowerCase().includes(q))
}

// ── By fit ───────────────────────────────────────────────────────────────────

interface FitRow {
  key: string
  fit_id: number
  fit_name: string
  hull: string
  location: string
  doctrines: string[]
  dfIds: number[]
  stock: number
  target: number
}

/** One row per fit per staging location. A fit used by several doctrines at the
 *  same location is one stock of ships, so it counts once at its highest target. */
function poolFits(fits: FleetFit[]): FitRow[] {
  const rows: FitRow[] = []
  for (const f of fits) {
    const byLoc = new Map<string, FitRow>()
    for (const d of f.doctrines) {
      const loc = d.location_name ?? 'No staging location'
      const row = byLoc.get(loc) ?? {
        key: `${f.fit_id}-${loc}`, fit_id: f.fit_id, fit_name: f.fit_name, hull: f.hull,
        location: loc, doctrines: [], dfIds: [], stock: 0, target: 0,
      }
      row.doctrines.push(d.doctrine_name)
      row.dfIds.push(d.df_id)
      row.target = Math.max(row.target, d.target_qty)
      row.stock = Math.max(row.stock, d.stock ?? 0)
      byLoc.set(loc, row)
    }
    rows.push(...byLoc.values())
  }
  return rows
}

type FitSortKey = 'fit' | 'location' | 'stock' | 'need'

function FitsView({ fits, query, filter, selection }: {
  fits: FleetFit[]; query: string; filter: StockFilter; selection: Selection
}) {
  const sort = useSort<FitSortKey>('need')
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = poolFits(fits)
      .filter(r => filter === 'all' || (filter === 'ready' ? r.stock >= r.target : r.stock < r.target))
      .filter(r => !q || matches(q, r.fit_name, r.hull, r.location, ...r.doctrines))
    const fill = (r: FitRow) => (r.target ? Math.min(r.stock, r.target) / r.target : 1)
    const val = (r: FitRow): number | string => {
      switch (sort.key) {
        case 'fit': return r.fit_name.toLowerCase()
        case 'location': return r.location.toLowerCase()
        case 'stock': return r.stock
        case 'need': return Math.max(0, r.target - r.stock) + (1 - fill(r))
      }
    }
    return list.sort((a, b) => {
      const av = val(a), bv = val(b)
      const c = av < bv ? -1 : av > bv ? 1 : 0
      return (sort.dir === 'asc' ? c : -c) || a.fit_name.localeCompare(b.fit_name)
    })
  }, [fits, query, filter, sort.key, sort.dir])

  if (rows.length === 0) return <p className="v2-empty">No fits match.</p>
  return (
    <div className="v2-table-wrap">
      <table className="v2-table">
        <thead>
          <tr>
            <th className="sel">
              <TriCheckbox ids={rows.flatMap(r => r.dfIds)} selection={selection} label="Select all fits shown" />
            </th>
            <Th label="Fit" k="fit" sort={sort} defaultDir="asc" />
            <th>Used by</th>
            <Th label="Location" k="location" sort={sort} defaultDir="asc" />
            <Th label="Stock / target" k="stock" sort={sort} align="right" />
            <Th label="Missing" k="need" sort={sort} align="right" />
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key} className={tone(r.stock, r.target)}>
              <td className="sel">
                <TriCheckbox ids={r.dfIds} selection={selection} label={`Select ${r.fit_name}`} dot />
              </td>
              <td>
                <Link href={`/doctrines/fits/${r.fit_id}`} className="name">{r.fit_name}</Link>
                {r.hull && !r.fit_name.toLowerCase().includes(r.hull.toLowerCase()) && <span className="muted"> ({r.hull})</span>}
              </td>
              <td className="muted">{r.doctrines.join(', ')}</td>
              <td className="muted">{r.location}</td>
              <td className="num"><b>{r.stock}</b><span className="muted"> / {r.target}</span></td>
              <td className="num">{r.stock >= r.target ? <span className="muted">–</span> : r.target - r.stock}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── By item ──────────────────────────────────────────────────────────────────

type ItemSortKey = 'item' | 'short' | 'needed' | 'cost'

function ItemsView({ items, query, shortOnly }: { items: FleetItem[]; query: string; shortOnly: boolean }) {
  const sort = useSort<ItemSortKey>('cost')
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const unit = (i: FleetItem) => i.import_cost ?? i.staging_price ?? 0
    const list = items
      .filter(i => !shortOnly || i.shortfall > 0)
      .filter(i => !q || matches(q, i.name, i.location_name, ...i.fits.map(f => f.fit_name)))
    const val = (i: FleetItem): number | string => {
      switch (sort.key) {
        case 'item': return i.name.toLowerCase()
        case 'short': return i.shortfall
        case 'needed': return i.total_needed
        case 'cost': return i.shortfall * unit(i)
      }
    }
    return list.sort((a, b) => {
      const av = val(a), bv = val(b)
      const c = av < bv ? -1 : av > bv ? 1 : 0
      return (sort.dir === 'asc' ? c : -c) || a.name.localeCompare(b.name)
    })
  }, [items, query, shortOnly, sort.key, sort.dir])

  if (rows.length === 0) return <p className="v2-empty">{shortOnly ? 'Nothing is short. Every item is on the market in the quantity your doctrines need.' : 'No items match.'}</p>
  return (
    <div className="v2-table-wrap">
      <table className="v2-table">
        <thead>
          <tr>
            <Th label="Item" k="item" sort={sort} defaultDir="asc" />
            <th>Location</th>
            <Th label="Needed" k="needed" sort={sort} align="right" />
            <th className="num">On market</th>
            <Th label="Short" k="short" sort={sort} align="right" />
            <th className="num">Local price</th>
            <th className="num">Import cost</th>
            <Th label="Cost to fill" k="cost" sort={sort} align="right" />
            <th>Used by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(i => {
            // One entry per fit; a fit shared by several doctrines counts at its highest target.
            const fits = new Map<number, { name: string; perFit: number; target: number }>()
            for (const f of i.fits) {
              const e = fits.get(f.fit_id) ?? { name: f.fit_name, perFit: f.qty_per_fit, target: 0 }
              e.target = Math.max(e.target, f.target)
              fits.set(f.fit_id, e)
            }
            const fitList = [...fits.values()]
            const cost = i.shortfall * (i.import_cost ?? i.staging_price ?? 0)
            return (
              <tr key={`${i.type_id}-${i.location_name}`} className={i.shortfall === 0 ? 'is-ready' : i.qty_available === 0 ? 'is-short' : 'is-partial'}>
                <td>
                  <span className="dot" aria-hidden />
                  <Link href={`/v2/items/${i.type_id}`} className="name">{i.name}</Link>
                </td>
                <td className="muted">{i.location_name}</td>
                <td className="num">{i.total_needed.toLocaleString()}</td>
                <td className="num muted">{i.qty_available.toLocaleString()}</td>
                <td className="num">{i.shortfall > 0 ? <b>{i.shortfall.toLocaleString()}</b> : <span className="muted">–</span>}</td>
                <td className="num muted">{isk(i.staging_price)}</td>
                <td className="num muted">{isk(i.import_cost)}</td>
                <td className="num">{i.shortfall > 0 ? isk(cost) : <span className="muted">–</span>}</td>
                <td className="muted" title={fitList.map(f => `${f.name}: ${f.perFit} per fit, target ${f.target}`).join('\n')}>
                  {fitList.length === 1 ? fitList[0].name : `${fitList.length} fits`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function TrialDoctrines() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const view: View = (['fits', 'items'] as const).includes(searchParams.get('view') as 'fits' | 'items')
    ? (searchParams.get('view') as View) : 'doctrines'

  const [report, setReport] = useState<DoctrineReport | null>(null)
  const [fleetFits, setFleetFits] = useState<FleetFit[] | null>(null)
  const [fleetItems, setFleetItems] = useState<FleetItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<StockFilter>('all')
  const [shortOnly, setShortOnly] = useState(true)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const selection: Selection = useMemo(() => ({
    selected,
    set: (ids, on) => setSelected(prev => {
      const next = new Set(prev)
      ids.forEach(id => (on ? next.add(id) : next.delete(id)))
      return next
    }),
  }), [selected])

  const load = useCallback(() => {
    const get = <T,>(url: string, set: (v: T) => void) =>
      fetch(url).then(r => { if (!r.ok) throw new Error(); return r.json() }).then(set).catch(() => setFailed(true))
    get<DoctrineReport>('/api/dashboard', setReport)
    get<FleetFit[]>('/api/fleet/fits', setFleetFits)
    get<FleetItem[]>('/api/fleet/items', setFleetItems)
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  // Scroll to a doctrine linked from a dashboard tile, once its card exists.
  useEffect(() => {
    if (report && view === 'doctrines' && window.location.hash) {
      document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: 'start' })
    }
  }, [report, view])

  function setView(v: View) {
    const p = new URLSearchParams(searchParams)
    v === 'doctrines' ? p.delete('view') : p.set('view', v)
    router.replace(p.toString() ? `${pathname}?${p}` : pathname, { scroll: false })
  }

  const doctrines = useMemo(() => sortDoctrines(report?.doctrine_summary ?? []), [report])
  const belowCount = doctrines.filter(d => d.status !== 'ready' && d.status !== 'unknown').length
  const readyCount = doctrines.filter(d => d.status === 'ready').length
  const shortItems = fleetItems?.filter(i => i.shortfall > 0) ?? []

  // A doctrine matches if its name or location matches (all fits shown), or if
  // any of its fits match (only those fits shown).
  const visibleDoctrines = useMemo(() => {
    const q = query.trim().toLowerCase()
    return doctrines
      .filter(d => filter === 'all' || (filter === 'ready' ? d.status === 'ready' : d.status !== 'ready' && d.status !== 'unknown'))
      .map(d => {
        let fits = d.fits
        if (filter === 'below') fits = fits.filter(f => fitFill(f) < 1)
        if (!q || matches(q, d.name, d.location_name)) return { d, fits }
        const hits = fits.filter(f => matches(q, f.name, f.ship_name, f.limiting_item))
        return hits.length ? { d, fits: hits } : null
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
  }, [doctrines, query, filter])

  const loaded = view === 'doctrines' ? report : view === 'fits' ? fleetFits : fleetItems

  const selectedDoctrines = useMemo(
    () => doctrines.filter(d => d.fits.some(f => f.df_id != null && selected.has(f.df_id))).length,
    [doctrines, selected],
  )
  const shopHref = selected.size > 0 ? `/v2/buying?fits=${[...selected].sort((a, b) => a - b).join(',')}` : '/v2/buying'

  return (
    <section aria-labelledby="doctrines-title" className={selected.size > 0 ? 'v2-selecting' : undefined}>
      <div className="v2-board-head">
        <h2 id="doctrines-title">Doctrines</h2>
        {report && (
          <p>
            {report.doctrines_fully_stocked} of {report.doctrine_count} doctrines at target.{' '}
            <MarketFreshness lastPoll={report.last_poll} nextPoll={report.next_poll} />
          </p>
        )}
        <Link href="/availability">Edit doctrines and fits</Link>
        <Link href={shopHref}>{selected.size > 0 ? `Buy what’s missing for ${selected.size} selected` : 'Buy what’s missing'}</Link>
      </div>

      <div className="v2-filters">
        <div className="v2-tabs" role="tablist" aria-label="View">
          {VIEWS.map(v => (
            <button key={v.key} role="tab" aria-selected={view === v.key} onClick={() => setView(v.key)}>{v.label}</button>
          ))}
        </div>
        <input
          type="search"
          className="v2-search"
          placeholder={view === 'items' ? 'Search items, locations or fits' : 'Search doctrines, fits, ships or items'}
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search"
        />
        {view === 'items' ? (
          <>
            <button className="v2-chip" aria-pressed={shortOnly} onClick={() => setShortOnly(true)}>
              Short<small>{shortItems.length}</small>
            </button>
            <button className="v2-chip" aria-pressed={!shortOnly} onClick={() => setShortOnly(false)}>
              All items<small>{fleetItems?.length ?? 0}</small>
            </button>
          </>
        ) : (
          <>
            <button className="v2-chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              All{view === 'doctrines' && <small>{doctrines.length}</small>}
            </button>
            <button className="v2-chip" aria-pressed={filter === 'below'} onClick={() => setFilter('below')}>
              Below target{view === 'doctrines' && <small>{belowCount}</small>}
            </button>
            <button className="v2-chip" aria-pressed={filter === 'ready'} onClick={() => setFilter('ready')}>
              At target{view === 'doctrines' && <small>{readyCount}</small>}
            </button>
          </>
        )}
      </div>

      <StatusLegend />

      {failed && !loaded ? (
        <p className="v2-calm">The doctrines couldn&apos;t be loaded. Check that the backend is running, then reload.</p>
      ) : !loaded ? (
        <div className="v2-skeleton" aria-busy="true" />
      ) : view === 'fits' ? (
        <FitsView fits={fleetFits!} query={query} filter={filter} selection={selection} />
      ) : view === 'items' ? (
        <ItemsView items={fleetItems!} query={query} shortOnly={shortOnly} />
      ) : doctrines.length === 0 ? (
        <p className="v2-empty">
          No doctrines yet. <Link href="/availability" style={{ color: 'var(--brass)' }}>Add your first doctrine</Link> to track its stock here.
        </p>
      ) : visibleDoctrines.length === 0 ? (
        <p className="v2-empty">
          Nothing matches{query ? ` “${query}”` : ''}{filter !== 'all' ? ' with this filter' : ''}.{' '}
          <button className="v2-chip" onClick={() => { setQuery(''); setFilter('all') }}>Clear search and filter</button>
        </p>
      ) : (
        <div className="v2-board">
          {visibleDoctrines.map(({ d, fits }, i) => <DoctrineCard key={d.id} d={d} index={i} fits={fits} selection={selection} />)}
        </div>
      )}

      {selected.size > 0 && (
        <div className="v2-selbar" role="region" aria-label="Selected fits">
          <span>
            <strong>{selected.size}</strong> fit{selected.size === 1 ? '' : 's'} selected
            <span className="muted"> from {selectedDoctrines} doctrine{selectedDoctrines === 1 ? '' : 's'}</span>
          </span>
          <button className="v2-chip" onClick={() => setSelected(new Set())}>Clear selection</button>
          <Link href={shopHref} className="go">Buy what&apos;s missing for these</Link>
        </div>
      )}
    </section>
  )
}
