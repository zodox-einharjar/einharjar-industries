import Link from 'next/link'
import { useEffect, useRef } from 'react'

// Shared by the trial dashboard (compact tiles) and the trial doctrines page (full cards).
// Data comes from the existing /api/dashboard doctrine report.

export interface FitSummary {
  df_id?: number
  fit_id?: number
  name: string
  ship_name?: string
  status: string
  stock: number | null
  target: number
  price: number | null
  limiting_item?: string | null
  items_short?: number
}

export interface DoctrineSummary {
  id: number
  name: string
  location_name?: string | null
  status: 'ready' | 'partial' | 'short' | 'unknown'
  fits_stocked: number
  fits_total: number
  fits: FitSummary[]
}

export interface DoctrineReport {
  doctrine_count: number
  doctrines_fully_stocked: number
  last_poll: string | null
  next_poll: string | null
  doctrine_summary: DoctrineSummary[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isk(n: number | null | undefined): string {
  if (n == null) return '–'
  const abs = Math.abs(n)
  const fmt = (v: number, s: string) => `${parseFloat(v.toPrecision(3))}${s}`
  if (abs >= 1e9) return fmt(n / 1e9, 'B')
  if (abs >= 1e6) return fmt(n / 1e6, 'M')
  if (abs >= 1e3) return fmt(n / 1e3, 'K')
  return Math.round(n).toLocaleString()
}

export function minutesSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
}

export function agoText(minutes: number): string {
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const h = Math.floor(minutes / 60)
  return `${h} hour${h === 1 ? '' : 's'} ago`
}

/** Share of the doctrine's total target that's stockable, so a doctrine with one
 *  empty fit out of ten reads very differently from one with ten empty fits. */
export function readiness(d: DoctrineSummary): number {
  const target = d.fits.reduce((s, f) => s + f.target, 0)
  if (!target) return 0
  return d.fits.reduce((s, f) => s + Math.min(f.stock ?? 0, f.target), 0) / target
}

/** Fraction of a fit's target in stock; a fit with no target counts as fully stocked. */
export function fitFill(f: FitSummary): number {
  return f.target > 0 ? Math.min(f.stock ?? 0, f.target) / f.target : 1
}

function fitTone(f: FitSummary): 'is-ready' | 'is-partial' | 'is-short' {
  const stock = f.stock ?? 0
  return stock >= f.target ? 'is-ready' : stock === 0 ? 'is-short' : 'is-partial'
}

const DOCTRINE_TONE: Record<DoctrineSummary['status'], string> = {
  ready: 'is-ready', partial: 'is-partial', short: 'is-short', unknown: 'is-unset',
}

/** Least-stocked doctrines first; doctrines without a staging location last. */
export function sortDoctrines(list: DoctrineSummary[]): DoctrineSummary[] {
  return [...list].sort((a, b) => {
    if ((a.status === 'unknown') !== (b.status === 'unknown')) return a.status === 'unknown' ? 1 : -1
    return readiness(a) - readiness(b) || a.name.localeCompare(b.name)
  })
}

/** Market data is stale once the scheduled poll is overdue by more than 10 minutes
 *  (so a 30-minute interval doesn't read as stale after 15). Without a schedule,
 *  anything older than an hour counts. */
export function marketStale(lastPoll: string | null, nextPoll?: string | null): boolean {
  if (!lastPoll) return true
  if (nextPoll) return minutesSince(nextPoll) > 10  // minutes the scheduled poll is overdue
  return minutesSince(lastPoll) > 60
}

export function MarketFreshness({ lastPoll, nextPoll }: { lastPoll: string | null; nextPoll?: string | null }) {
  if (!lastPoll) return <span className="v2-stale">Markets haven&apos;t been polled yet.</span>
  const minutes = minutesSince(lastPoll)
  return <span className={marketStale(lastPoll, nextPoll) ? 'v2-stale' : undefined}>Market prices from {agoText(minutes)}.</span>
}

export function StatusLegend() {
  return (
    <div className="v2-legend">
      <span className="is-ready">At target</span>
      <span className="is-partial">Partly stocked</span>
      <span className="is-short">None on the market</span>
    </div>
  )
}

// ── Selection (doctrine-fit ids, as used by Shopping's scope) ─────────────────

export interface Selection {
  selected: Set<number>
  /** Turn a group of doctrine-fit ids on or off together. */
  set: (dfIds: number[], on: boolean) => void
}

/** Custom checkbox. With `dot`, the stock-status dot shows in its place until the
 *  row is hovered/focused, the box is ticked, or anything on the page is selected. */
export function TriCheckbox({ ids, selection, label, dot }: {
  ids: number[]; selection: Selection; label: string; dot?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const on = ids.filter(id => selection.selected.has(id)).length
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = on > 0 && on < ids.length
  }, [on, ids.length])
  return (
    <span className={`v2-pick${on > 0 ? ' on' : ''}${dot ? ' with-dot' : ''}`}>
      {dot && <span className="dot" aria-hidden />}
      <input
        ref={ref}
        type="checkbox"
        className="v2-check"
        checked={ids.length > 0 && on === ids.length}
        disabled={ids.length === 0}
        onChange={() => selection.set(ids, on < ids.length)}
        onClick={e => e.stopPropagation()}
        aria-label={label}
      />
    </span>
  )
}

// ── Doctrine header (shared by tile and card) ─────────────────────────────────

function DoctrineHead({ d, index, href, compact, selection, shownFits }: {
  d: DoctrineSummary; index: number; href?: string; compact?: boolean; selection?: Selection; shownFits?: FitSummary[]
}) {
  const unset = d.status === 'unknown'
  // The doctrine checkbox covers the fits currently shown (a filter may hide some).
  const dfIds = (shownFits ?? d.fits).flatMap(f => (f.df_id != null ? [f.df_id] : []))
  const body = (
    <>
      {!unset && <div className="v2-doc-fill" style={{ width: `${readiness(d) * 100}%`, ['--i' as string]: index }} />}
      {selection && !unset && <TriCheckbox ids={dfIds} selection={selection} label={`Select all fits in ${d.name}`} />}
      <span className="v2-doc-title">
        <span className="v2-doc-name">{d.name}</span>
        <span className="v2-doc-loc">{d.location_name ?? 'No staging location set'}</span>
      </span>
      {!unset && (
        <span className="v2-doc-count" title={`${d.fits_stocked} of ${d.fits_total} fits at target`}>
          {compact
            ? <><strong>{d.fits_stocked}</strong>/{d.fits_total} fits</>
            : <><strong>{d.fits_stocked}</strong> of {d.fits_total} at target</>}
        </span>
      )}
    </>
  )
  return href
    ? <Link href={href} className="v2-doc-head">{body}</Link>
    : <div className="v2-doc-head">{body}</div>
}

function sortFits(fits: FitSummary[]): FitSummary[] {
  return [...fits].sort((a, b) => fitFill(a) - fitFill(b) || a.name.localeCompare(b.name))
}

/** Every fit with stock, cost and what limits it — fits needing stock first. */
function FitList({ fits, selection }: { fits: FitSummary[]; selection?: Selection }) {
  return (
    <ul className={`v2-fitlist${selection ? ' selectable' : ''}`}>
      {sortFits(fits).map((f, j) => {
        const stock = f.stock ?? 0
        const showShip = f.ship_name && !f.name.toLowerCase().includes(f.ship_name.toLowerCase())
        return (
          <li key={j} className={`v2-fitrow ${fitTone(f)}`}>
            {selection && f.df_id != null
              ? <TriCheckbox ids={[f.df_id]} selection={selection} label={`Select ${f.name}`} dot />
              : <span className="dot" aria-hidden />}
            <span className="fit" title={f.name}>
              {f.fit_id != null
                ? <Link href={`/doctrines/fits/${f.fit_id}`}>{f.name}</Link>
                : f.name}
              {showShip && <span className="ship"> ({f.ship_name})</span>}
            </span>
            <span className="price" title="Cost of one fit at the staging market (or imported)">{f.price != null ? isk(f.price) : ''}</span>
            <span className="qty"><b>{stock}</b><span> / {f.target}</span></span>
            {stock < f.target && f.limiting_item && (
              <span className="limit">
                Limited by <em>{f.limiting_item}</em>
                {f.items_short && f.items_short > 1 ? `, ${f.items_short - 1} more item${f.items_short > 2 ? 's' : ''} short` : ''}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Dashboard tile: header plus one colored segment per fit. Hovering (or focusing)
 *  drops the full fit list down over the tiles below, without reflowing the grid. */
export function DoctrineTile({ d, index }: { d: DoctrineSummary; index: number }) {
  const unset = d.status === 'unknown'
  return (
    <article className={`v2-doc v2-tile ${DOCTRINE_TONE[d.status]}`}>
      <DoctrineHead d={d} index={index} href={`/v2/doctrines#doctrine-${d.id}`} compact />
      {!unset && (
        <>
          <div className="v2-segs" aria-hidden>
            {sortFits(d.fits).map((f, j) => <span key={j} className={`v2-seg ${fitTone(f)}`} />)}
          </div>
          <div className="v2-tile-pop">
            <FitList fits={d.fits} />
          </div>
        </>
      )}
    </article>
  )
}

/** Doctrines page card: header plus every fit with stock, cost and what limits it. */
export function DoctrineCard({ d, index, fits, selection }: {
  d: DoctrineSummary; index: number; fits?: FitSummary[]; selection?: Selection
}) {
  return (
    <article id={`doctrine-${d.id}`} className={`v2-doc ${DOCTRINE_TONE[d.status]}`}>
      <DoctrineHead d={d} index={index} selection={selection} shownFits={fits} />
      {d.status !== 'unknown' && <FitList fits={fits ?? d.fits} selection={selection} />}
    </article>
  )
}
