'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { agoText, minutesSince } from '../_shared/doctrines'
import { Switch } from '../_shared/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Health {
  issues: { severity: 'danger' | 'warn'; area: string; text: string }[]
  markets: {
    interval_minutes: number
    next_poll: string | null
    last_poll: string | null
    locations: { id: number; name: string; type: string; last_fetched: string | null; orders: number; problem: string | null }[]
  }
  syncs: { key: string; label: string; last_synced: string | null; stale: boolean }[]
  characters: { character_id: number; name: string; corp_name: string | null; signed_in: boolean; polling: string[]; blocked: string[] }[]
  esi: { error_budget_remaining: number }
}

interface Location {
  id: number
  name: string
  eve_id: number
  location_type: 'station' | 'structure'
  region_id: number
  system_id: number | null
  broker_fee_pct: number
  sales_tax_pct: number
  scc_surcharge_pct: number
  use_for_inventory: boolean
}

interface Route {
  id: number
  from_id: number
  to_id: number
  isk_per_m3: number
  value_pct: number   // percent as returned by the API
}

interface Candidate {
  eve_id: number
  name: string | null
  type: 'station' | 'structure'
  system_id: number | null
  system_name: string | null
  added?: boolean
}

interface Char {
  character_id: number
  character_name: string
  corporation_id: number | null
  corp_name: string | null
  portrait_url: string
  scopes: string[]
}

type PollKey =
  | 'poll_char_orders' | 'poll_corp_orders' | 'poll_char_wallet' | 'poll_corp_wallet'
  | 'poll_char_contracts' | 'poll_corp_contracts' | 'poll_char_industry_jobs' | 'poll_corp_industry_jobs'

interface AppSettings extends Record<PollKey, number[]> {
  poll_interval_minutes: number
  main_character_id: number | null
  reprocessing_efficiency_pct: number
  reprocessing_gas_efficiency_pct: number
  reprocessing_fee_pct: number
  relist_discount_pct: number
}

interface WalletSources {
  characters: { character_id: number; name: string; has_access: boolean; selected: boolean; error: string | null }[]
  corporations: {
    corporation_id: number
    name: string
    access_via: string | null
    divisions: { division: number; label: string; selected: boolean; error: string | null }[]
  }[]
}

const POLLS: { key: PollKey; label: string; scope: string; corp: boolean }[] = [
  { key: 'poll_char_orders', label: 'Market orders', scope: 'esi-markets.read_character_orders.v1', corp: false },
  { key: 'poll_char_wallet', label: 'Wallet transactions', scope: 'esi-wallet.read_character_wallet.v1', corp: false },
  { key: 'poll_char_contracts', label: 'Contracts', scope: 'esi-contracts.read_character_contracts.v1', corp: false },
  { key: 'poll_char_industry_jobs', label: 'Industry jobs', scope: 'esi-industry.read_character_jobs.v1', corp: false },
  { key: 'poll_corp_orders', label: 'Corp market orders', scope: 'esi-markets.read_corporation_orders.v1', corp: true },
  { key: 'poll_corp_wallet', label: 'Corp wallet transactions', scope: 'esi-wallet.read_corporation_wallets.v1', corp: true },
  { key: 'poll_corp_contracts', label: 'Corp contracts', scope: 'esi-contracts.read_corporation_contracts.v1', corp: true },
  { key: 'poll_corp_industry_jobs', label: 'Corp industry jobs', scope: 'esi-industry.read_corporation_jobs.v1', corp: true },
]

const TABS = [
  { key: 'health', label: 'Health' },
  { key: 'locations', label: 'Locations & freight' },
  { key: 'characters', label: 'Characters & wallets' },
  { key: 'general', label: 'General' },
] as const
type Tab = typeof TABS[number]['key']

// ── Helpers ───────────────────────────────────────────────────────────────────

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init?.body ? { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } } : init)
  if (!r.ok) {
    let detail = ''
    try { detail = (await r.json()).detail ?? '' } catch {}
    throw new Error(detail || `Request failed (${r.status})`)
  }
  return r.status === 204 ? (undefined as T) : r.json()
}

function when(iso: string | null): string {
  return iso ? agoText(minutesSince(iso)) : 'never'
}

/** A number field that saves on blur or Enter, and reverts on Escape. */
function NumberCell({ value, onSave, step = 0.01, suffix, width = 76, label }: {
  value: number; onSave: (v: number) => Promise<void>; step?: number; suffix?: string; width?: number; label: string
}) {
  const [text, setText] = useState(String(value))
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle')
  useEffect(() => { setText(String(value)) }, [value])
  async function commit() {
    const v = Number(text)
    if (!Number.isFinite(v) || v === value) { setText(String(value)); return }
    setState('saving')
    try { await onSave(v); setState('idle') } catch { setState('error'); setText(String(value)) }
  }
  return (
    <span className="v2-numcell">
      <input
        type="number" step={step} value={text} aria-label={label}
        className={`v2-qty${state === 'error' ? ' error' : ''}`} style={{ width }}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') { setText(String(value)); (e.target as HTMLInputElement).blur() }
        }}
      />
      {suffix && <span className="muted">{suffix}</span>}
    </span>
  )
}

// ── Health ───────────────────────────────────────────────────────────────────

function HealthTab({ onGo }: { onGo: (t: Tab) => void }) {
  const [h, setH] = useState<Health | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [polling, setPolling] = useState<Set<number>>(new Set())

  const load = useCallback(() => {
    api<Health>('/api/settings/health').then(setH).catch(e => setError(e.message))
  }, [])
  useEffect(() => { load(); const id = setInterval(load, 30_000); return () => clearInterval(id) }, [load])

  async function pollNow(id: number) {
    setPolling(p => new Set(p).add(id))
    try { await api(`/api/locations/${id}/poll`, { method: 'POST' }) } catch {}
    setPolling(p => { const n = new Set(p); n.delete(id); return n })
    load()
  }

  if (error) return <p className="v2-calm">Health couldn&apos;t be checked: {error}</p>
  if (!h) return <div className="v2-skeleton" aria-busy="true" />

  const areaTab: Record<string, Tab> = { markets: 'locations', characters: 'characters', syncs: 'characters' }

  return (
    <div className="v2-settings-stack">
      <section>
        {h.issues.length === 0 ? (
          <p className="v2-allgood"><span className="dot" aria-hidden />Everything is working. Markets and syncs are up to date.</p>
        ) : (
          <ul className="v2-todo">
            {h.issues.map((i, n) => (
              <li key={n} className={i.severity}>
                <button className="v2-todo-btn" onClick={() => onGo(areaTab[i.area] ?? 'health')}>
                  <span className="dot" aria-hidden />
                  <span className="what">{i.text}</span>
                  <span className="act">{areaTab[i.area] === 'characters' ? 'Characters' : 'Locations'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="v2-col-head">
          <h4>Market data</h4>
          <p>
            Polled every {h.markets.interval_minutes} minutes. Last poll {when(h.markets.last_poll)}
            {h.markets.next_poll && <>, next in {Math.max(0, -minutesSince(h.markets.next_poll))} minutes</>}.
          </p>
        </div>
        <table className="v2-table compact">
          <thead><tr><th>Location</th><th className="num">Sell orders</th><th>Updated</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {h.markets.locations.map(l => (
              <tr key={l.id} className={l.problem ? 'is-partial' : 'is-ready'}>
                <td><span className="dot" aria-hidden />{l.name} <span className="muted">{l.type}</span></td>
                <td className="num">{l.orders.toLocaleString()}</td>
                <td className="muted">{when(l.last_fetched)}</td>
                <td>{l.problem ? <span className="warn-text">{l.problem}</span> : <span className="muted">Up to date</span>}</td>
                <td className="num">
                  <button className="v2-btn" disabled={polling.has(l.id)} onClick={() => pollNow(l.id)}>
                    {polling.has(l.id) ? 'Polling…' : 'Poll now'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="v2-settings-two">
        <section>
          <div className="v2-col-head"><h4>Background syncs</h4><p>Pulled from ESI every 5 minutes for the characters set to poll them.</p></div>
          <ul className="v2-rows">
            {h.syncs.map(s => (
              <li key={s.key}>
                <span>{s.label}</span>
                <span className={`side${s.stale ? ' orange' : ''}`}>{s.last_synced ? `Synced ${when(s.last_synced)}` : 'Never synced'}</span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <div className="v2-col-head"><h4>Characters</h4><p>Who is signed in and what they poll.</p></div>
          <ul className="v2-rows">
            {h.characters.map(c => (
              <li key={c.character_id}>
                <span>
                  {c.name}
                  <span className="sub">{c.polling.length ? c.polling.join(', ') : 'Not polling anything'}</span>
                </span>
                <span className={`side${c.blocked.length ? ' red' : !c.signed_in ? '' : ''}`}>
                  {c.blocked.length ? 'Needs sign-in' : c.signed_in ? 'Signed in' : 'Not signed in'}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">ESI error budget: {h.esi.error_budget_remaining} of 100 left this minute.</p>
        </section>
      </div>
    </div>
  )
}

// ── Locations & freight ──────────────────────────────────────────────────────

function AddLocation({ onAdded, existing }: { onAdded: () => void; existing: Set<number> }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Candidate[]>([])
  const [structures, setStructures] = useState<{ can_resolve: boolean; structures: Candidate[] } | null>(null)
  const [loadingStructures, setLoadingStructures] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    const t = setTimeout(() => {
      api<Candidate[]>(`/api/settings/location-search?q=${encodeURIComponent(q.trim())}`).then(setResults).catch(() => setResults([]))
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  async function add(c: Candidate) {
    setBusy(c.eve_id); setError(null)
    try {
      await api('/api/locations', {
        method: 'POST',
        body: JSON.stringify({ name: c.name ?? `Structure ${c.eve_id}`, eve_id: c.eve_id, location_type: c.type, system_id: c.system_id }),
      })
      onAdded()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const structureMatches = (structures?.structures ?? [])
    .filter(s => !existing.has(s.eve_id))
    .filter(s => !q.trim() || (s.name ?? '').toLowerCase().includes(q.trim().toLowerCase()))

  return (
    <section className="v2-addloc">
      <div className="v2-col-head">
        <h4>Add a location</h4>
        <p>Search NPC stations by name, or pick a player structure your characters have used.</p>
      </div>
      <input
        type="search" className="v2-search wide" placeholder="Station name, for example Jita 4-4 or Amarr VIII"
        value={q} onChange={e => setQ(e.target.value)} aria-label="Search stations"
      />
      {error && <p className="v2-warn-inline">{error}</p>}
      {results.length > 0 && (
        <ul className="v2-rows">
          {results.map(r => (
            <li key={r.eve_id}>
              <span>{r.name}<span className="sub">{r.system_name}, NPC station</span></span>
              {r.added || existing.has(r.eve_id)
                ? <span className="side">Already added</span>
                : <button className="v2-btn" disabled={busy === r.eve_id} onClick={() => add(r)}>Add</button>}
            </li>
          ))}
        </ul>
      )}
      <div className="v2-addloc-structures">
        {!structures ? (
          <button
            className="v2-btn" disabled={loadingStructures}
            onClick={() => {
              setLoadingStructures(true)
              api<{ can_resolve: boolean; structures: Candidate[] }>('/api/settings/structure-candidates')
                .then(setStructures).catch(e => setError(e.message)).finally(() => setLoadingStructures(false))
            }}
          >
            {loadingStructures ? 'Looking up structures…' : 'Show structures I’ve used'}
          </button>
        ) : structureMatches.length === 0 ? (
          <p className="muted small">No other structures found in your contracts, industry jobs or market orders.</p>
        ) : (
          <>
            {!structures.can_resolve && <p className="v2-warn-inline">No signed-in character can read structure names, so some show only their ID.</p>}
            <ul className="v2-rows">
              {structureMatches.map(s => (
                <li key={s.eve_id}>
                  <span>
                    {s.name ?? `Structure ${s.eve_id}`}
                    <span className="sub">{s.system_name ? `${s.system_name}, player structure` : 'No docking access, so the name and system are unknown'}</span>
                  </span>
                  <button className="v2-btn" disabled={busy === s.eve_id || !s.system_id} onClick={() => add(s)}>Add</button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}

function LocationsTab() {
  const [locs, setLocs] = useState<Location[] | null>(null)
  const [routes, setRoutes] = useState<Route[]>([])
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState<number | null>(null)
  const [newFrom, setNewFrom] = useState<Record<number, number | ''>>({})

  const load = useCallback(() => {
    Promise.all([api<Location[]>('/api/locations'), api<Route[]>('/api/freight-routes')])
      .then(([l, r]) => { setLocs(l.sort((a, b) => a.name.localeCompare(b.name))); setRoutes(r) })
      .catch(e => setError(e.message))
  }, [])
  useEffect(load, [load])

  const jita = locs?.find(l => l.eve_id === 60003760)
  const nameOf = (id: number) => locs?.find(l => l.id === id)?.name ?? `#${id}`

  async function patchLoc(id: number, patch: Partial<Location>) {
    const updated = await api<Location>(`/api/locations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    setLocs(ls => ls?.map(l => (l.id === id ? { ...l, ...updated } : l)) ?? null)
  }
  async function saveRoute(r: Route, patch: Partial<Pick<Route, 'isk_per_m3' | 'value_pct'>>) {
    const updated = await api<Route>(`/api/freight-routes/${r.id}`, { method: 'PUT', body: JSON.stringify(patch) })
    setRoutes(rs => rs.map(x => (x.id === r.id ? updated : x)))
  }
  async function addRoute(fromId: number, toId: number) {
    setAdding(toId)
    try {
      const created = await api<Route>('/api/freight-routes', {
        method: 'POST', body: JSON.stringify({ from_id: fromId, to_id: toId, isk_per_m3: 0, value_pct: 0 }),
      })
      setRoutes(rs => [...rs, created])
      setNewFrom(n => ({ ...n, [toId]: '' }))
    } catch (e) { setError((e as Error).message) } finally { setAdding(null) }
  }
  async function removeRoute(id: number) {
    await api(`/api/freight-routes/${id}`, { method: 'DELETE' })
    setRoutes(rs => rs.filter(r => r.id !== id))
  }
  async function removeLoc(l: Location) {
    if (!window.confirm(`Remove ${l.name}? Its market data and freight routes go with it.`)) return
    try {
      await api(`/api/locations/${l.id}`, { method: 'DELETE' })
      load()
    } catch (e) { setError((e as Error).message) }
  }

  if (error && !locs) return <p className="v2-calm">{error}</p>
  if (!locs) return <div className="v2-skeleton" aria-busy="true" />

  return (
    <div className="v2-settings-stack">
      {error && <p className="v2-warn">{error}</p>}
      <div className="v2-loc-list">
        {locs.map(l => {
          const inbound = routes.filter(r => r.to_id === l.id)
          const fromChoices = locs.filter(x => x.id !== l.id && !inbound.some(r => r.from_id === x.id))
          return (
            <article key={l.id} className="v2-loc">
              <header>
                <div>
                  <h4>{l.name}</h4>
                  <span className="muted small">
                    {l.location_type === 'structure' ? 'Player structure' : 'NPC station'}, EVE ID {l.eve_id}
                    {l.id === jita?.id && ', the import hub'}
                  </span>
                </div>
                <button className="v2-x" onClick={() => removeLoc(l)} aria-label={`Remove ${l.name}`} title="Remove location">✕</button>
              </header>

              <Switch
                on={l.use_for_inventory}
                label="Inventory station"
                onChange={v => patchLoc(l.id, { use_for_inventory: v }).catch(e => setError((e as Error).message))}
              >
                {l.use_for_inventory
                  ? 'We keep stock here: it gets an Inventory tab and can be a transfer, import or reprocessing target.'
                  : 'Not used for stock. It only shows on Inventory while it still holds items.'}
              </Switch>

              <div className="v2-loc-fees">
                <span className="v2-field-label">Selling fees</span>
                <label>Broker <NumberCell value={l.broker_fee_pct} suffix="%" label="Broker fee" onSave={v => patchLoc(l.id, { broker_fee_pct: v })} /></label>
                <label>Sales tax <NumberCell value={l.sales_tax_pct} suffix="%" label="Sales tax" onSave={v => patchLoc(l.id, { sales_tax_pct: v })} /></label>
                <label>SCC surcharge <NumberCell value={l.scc_surcharge_pct} suffix="%" label="SCC surcharge" onSave={v => patchLoc(l.id, { scc_surcharge_pct: v })} /></label>
              </div>

              {l.id !== jita?.id && (
                <div className="v2-loc-routes">
                  <span className="v2-field-label">Freight to here</span>
                  {inbound.length === 0 && <span className="muted small">No freight routes. Imports to here are priced without freight.</span>}
                  {inbound.map(r => (
                    <div key={r.id} className="v2-route">
                      <span className="from">From {nameOf(r.from_id)}</span>
                      <NumberCell value={r.isk_per_m3} step={1} suffix="ISK/m³" width={96} label="ISK per cubic metre" onSave={v => saveRoute(r, { isk_per_m3: v })} />
                      <NumberCell value={r.value_pct} suffix="% of value" label="Collateral percent" onSave={v => saveRoute(r, { value_pct: v })} />
                      <button className="v2-x" onClick={() => removeRoute(r.id)} aria-label="Remove route" title="Remove route">✕</button>
                    </div>
                  ))}
                  {fromChoices.length > 0 && (
                    <div className="v2-route add">
                      <select
                        className="v2-select" value={newFrom[l.id] ?? (inbound.length === 0 && jita ? jita.id : '')}
                        onChange={e => setNewFrom(n => ({ ...n, [l.id]: e.target.value ? Number(e.target.value) : '' }))}
                      >
                        <option value="">Add a route from…</option>
                        {fromChoices.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                      <button
                        className="v2-btn"
                        disabled={adding === l.id || !(newFrom[l.id] ?? (inbound.length === 0 && jita ? jita.id : ''))}
                        onClick={() => addRoute(Number(newFrom[l.id] ?? jita?.id), l.id)}
                      >
                        Add route
                      </button>
                    </div>
                  )}
                </div>
              )}
            </article>
          )
        })}
      </div>
      <AddLocation onAdded={load} existing={new Set(locs.map(l => l.eve_id))} />
    </div>
  )
}

// ── Characters & wallets ─────────────────────────────────────────────────────

function CharactersTab() {
  const [chars, setChars] = useState<Char[] | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [wallets, setWallets] = useState<WalletSources | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    Promise.all([api<Char[]>('/api/auth/characters'), api<AppSettings>('/api/settings'), api<WalletSources>('/api/wallet/sources')])
      .then(([c, s, w]) => { setChars(c); setSettings(s); setWallets(w) })
      .catch(e => setError(e.message))
  }, [])
  useEffect(load, [load])

  async function togglePoll(key: PollKey, characterId: number, on: boolean) {
    if (!settings) return
    const next = on ? [...settings[key], characterId] : settings[key].filter(id => id !== characterId)
    setSettings({ ...settings, [key]: next })
    try {
      setSettings(await api<AppSettings>('/api/settings', { method: 'PATCH', body: JSON.stringify({ [key]: next }) }))
    } catch (e) { setError((e as Error).message); load() }
  }

  async function setMain(characterId: number) {
    if (!settings) return
    setSettings({ ...settings, main_character_id: characterId })
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ main_character_id: characterId }) }).catch(() => load())
  }

  async function removeChar(c: Char) {
    if (!window.confirm(`Remove ${c.character_name}? The app stops polling for this character and forgets its sign-in.`)) return
    await api(`/api/auth/characters/${c.character_id}`, { method: 'DELETE' }).catch(e => setError(e.message))
    load()
  }

  async function saveWallets(next: WalletSources) {
    setWallets(next)
    setSaving(true)
    try {
      const body = {
        characters: next.characters.filter(c => c.selected).map(c => c.character_id),
        corps: Object.fromEntries(next.corporations.map(c => [c.corporation_id, c.divisions.filter(d => d.selected).map(d => d.division)])),
      }
      setWallets(await api<WalletSources>('/api/wallet/sources', { method: 'PUT', body: JSON.stringify(body) }))
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }

  if (error && !chars) return <p className="v2-calm">{error}</p>
  if (!chars || !settings || !wallets) return <div className="v2-skeleton" aria-busy="true" />

  return (
    <div className="v2-settings-stack">
      {error && <p className="v2-warn">{error}</p>}
      <section>
        <div className="v2-col-head">
          <h4>Characters</h4>
          <p>Sign in with EVE to add a character. Sign in as corporation to also read corp orders, wallets, contracts and jobs.</p>
          <span className="v2-col-actions">
            <a className="v2-btn" href="/auth/login?type=character">Add character</a>
            <a className="v2-btn primary" href="/auth/login?type=corporation">Add with corp access</a>
          </span>
        </div>
        <div className="v2-char-list">
          {chars.map(c => {
            const has = (scope: string) => c.scopes.includes(scope)
            const corpAccess = has('esi-markets.read_corporation_orders.v1')
            return (
              <article key={c.character_id} className="v2-char">
                <header>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={c.portrait_url} alt="" width={40} height={40} />
                  <div className="who">
                    <h4>{c.character_name}</h4>
                    <span className="muted small">{c.corp_name ?? 'Corporation unknown'}</span>
                  </div>
                  <label className="v2-mainpick">
                    <input type="radio" name="main" checked={settings.main_character_id === c.character_id} onChange={() => setMain(c.character_id)} />
                    Main
                  </label>
                  <a className="v2-link" href={`/auth/login?type=${corpAccess ? 'corporation' : 'character'}`}>Sign in again</a>
                  <button className="v2-x" onClick={() => removeChar(c)} aria-label={`Remove ${c.character_name}`} title="Remove character">✕</button>
                </header>
                <div className="v2-char-polls">
                  {POLLS.map(p => {
                    const allowed = has(p.scope) && (!p.corp || !!c.corporation_id)
                    return (
                      <Switch
                        key={p.key}
                        on={settings[p.key].includes(c.character_id)}
                        disabled={!allowed}
                        onChange={on => togglePoll(p.key, c.character_id, on)}
                        label={p.label}
                      >
                        {allowed ? undefined : p.corp ? 'Needs corp access' : 'Needs sign-in'}
                      </Switch>
                    )
                  })}
                </div>
              </article>
            )
          })}
        </div>
      </section>

      <section>
        <div className="v2-col-head">
          <h4>Wallets on the dashboard</h4>
          <p>
            Choose which wallets add up to the dashboard total and chart. Corp divisions need a character in the
            corp signed in with corp access and the Accountant or Junior Accountant role in game.
            {saving && ' Saving…'}
          </p>
        </div>
        <div className="v2-settings-two">
          <div>
            <span className="v2-field-label">Characters</span>
            <div className="v2-checklist">
              {wallets.characters.map(c => (
                <label key={c.character_id} className={c.has_access ? undefined : 'disabled'}>
                  <input
                    type="checkbox" className="v2-check" checked={c.selected} disabled={!c.has_access}
                    onChange={e => saveWallets({ ...wallets, characters: wallets.characters.map(x => x.character_id === c.character_id ? { ...x, selected: e.target.checked } : x) })}
                  />
                  {c.name}
                  {!c.has_access && <span className="muted small">needs sign-in</span>}
                  {c.error && <span className="warn-text small">{c.error}</span>}
                </label>
              ))}
            </div>
          </div>
          <div>
            <span className="v2-field-label">Corporations</span>
            {wallets.corporations.length === 0 && (
              <p className="muted small">
                No corporation wallets available. <a className="v2-link" href="/auth/login?type=corporation">Sign in with corp access</a> as
                a character with the Accountant or Junior Accountant role to add them.
              </p>
            )}
            {wallets.corporations.map(corp => (
              <div key={corp.corporation_id} className="v2-checklist">
                <span className="corp">
                  {corp.name}
                  <span className="muted small">{corp.access_via ? `via ${corp.access_via}` : 'access lost, sign in again with corp access'}</span>
                </span>
                {corp.divisions.map(d => (
                  <label key={d.division} className={corp.access_via ? undefined : 'disabled'}>
                    <input
                      type="checkbox" className="v2-check" checked={d.selected} disabled={!corp.access_via}
                      onChange={e => saveWallets({
                        ...wallets,
                        corporations: wallets.corporations.map(x => x.corporation_id !== corp.corporation_id ? x : {
                          ...x, divisions: x.divisions.map(y => y.division === d.division ? { ...y, selected: e.target.checked } : y),
                        }),
                      })}
                    />
                    {d.label}
                    {d.error && <span className="warn-text small">{d.error}</span>}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

// ── General ──────────────────────────────────────────────────────────────────

function GeneralTab() {
  const [s, setS] = useState<AppSettings | null>(null)
  const [sde, setSde] = useState<{ installed_at: string | null; remote_last_modified: string | null } | null>(null)
  const [sdeCheck, setSdeCheck] = useState<{ remote_last_modified: string | null; update_available: boolean | null } | null>(null)
  const [sdeState, setSdeState] = useState<'idle' | 'checking' | 'updating' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<AppSettings>('/api/settings').then(setS).catch(e => setError(e.message))
    api<typeof sde>('/api/settings/sde-status').then(setSde).catch(() => {})
  }, [])

  async function patch(p: Partial<AppSettings>) {
    setS(await api<AppSettings>('/api/settings', { method: 'PATCH', body: JSON.stringify(p) }))
  }

  if (error) return <p className="v2-calm">{error}</p>
  if (!s) return <div className="v2-skeleton" aria-busy="true" />

  const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'unknown')

  return (
    <div className="v2-settings-stack narrow">
      <section className="v2-field">
        <span className="v2-field-label">Market polling</span>
        <label className="v2-inline">
          Poll staging and import markets every
          <select className="v2-select" value={s.poll_interval_minutes} onChange={e => patch({ poll_interval_minutes: Number(e.target.value) })}>
            {[5, 10, 15, 30, 60].map(m => <option key={m} value={m}>{m} minutes</option>)}
          </select>
        </label>
      </section>

      <section className="v2-field">
        <span className="v2-field-label">Reprocessing</span>
        <p className="muted small">Used for buyback ore pricing, the compressed-ore option in Buying, and reprocessing inventory.</p>
        <label className="v2-inline">Ore and ice yield <NumberCell value={s.reprocessing_efficiency_pct} suffix="%" label="Ore and ice yield" onSave={v => patch({ reprocessing_efficiency_pct: v })} /></label>
        <label className="v2-inline">Gas yield <NumberCell value={s.reprocessing_gas_efficiency_pct} suffix="%" label="Gas yield" onSave={v => patch({ reprocessing_gas_efficiency_pct: v })} /></label>
        <label className="v2-inline">Station fee <NumberCell value={s.reprocessing_fee_pct} suffix="% of output value" label="Station fee" onSave={v => patch({ reprocessing_fee_pct: v })} /></label>
      </section>

      <section className="v2-field">
        <span className="v2-field-label">Market orders</span>
        <p className="muted small">Discount on the broker fee when you change an order&apos;s price: 50% base, plus your Advanced Broker Relations skill. Used to add repricing fees to your stock cost.</p>
        <label className="v2-inline">Relist discount <NumberCell value={s.relist_discount_pct} suffix="%" label="Relist discount" onSave={v => patch({ relist_discount_pct: v })} /></label>
      </section>

      <section className="v2-field">
        <span className="v2-field-label">Static data (SDE)</span>
        <p className="muted small">
          Item names, volumes, stations and reprocessing yields come from CCP&apos;s static data export.
          Installed {fmtDate(sde?.installed_at)}.
          {sdeCheck && (sdeCheck.update_available
            ? ` A newer version from ${fmtDate(sdeCheck.remote_last_modified)} is available.`
            : sdeCheck.update_available === false ? ' This is the latest version.' : ' CCP couldn’t be reached.')}
        </p>
        <span className="v2-col-actions">
          <button
            className="v2-btn" disabled={sdeState === 'checking' || sdeState === 'updating'}
            onClick={async () => {
              setSdeState('checking')
              try { setSdeCheck(await api('/api/settings/sde-check')); setSdeState('idle') } catch { setSdeState('error') }
            }}
          >
            {sdeState === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
          {sdeCheck?.update_available && (
            <button
              className="v2-btn primary" disabled={sdeState === 'updating'}
              onClick={async () => {
                setSdeState('updating')
                try {
                  await api('/api/settings/update-sde', { method: 'POST' })
                  setSde(await api('/api/settings/sde-status'))
                  setSdeCheck({ ...sdeCheck, update_available: false })
                  setSdeState('done')
                } catch { setSdeState('error') }
              }}
            >
              {sdeState === 'updating' ? 'Updating, this takes a minute…' : 'Update static data'}
            </button>
          )}
          {sdeState === 'done' && <span className="muted small">Updated.</span>}
          {sdeState === 'error' && <span className="warn-text small">That didn&apos;t work. Try again in a moment.</span>}
        </span>
      </section>
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function TrialSettings() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const tab: Tab = (TABS.find(t => t.key === searchParams.get('tab'))?.key) ?? 'health'

  function go(t: Tab) {
    router.replace(t === 'health' ? pathname : `${pathname}?tab=${t}`, { scroll: false })
  }

  return (
    <section aria-labelledby="settings-title">
      <div className="v2-board-head">
        <h2 id="settings-title">Settings</h2>
        <a href="/settings" className="v2-link">Classic settings</a>
      </div>
      <div className="v2-filters">
        <div className="v2-tabs" role="tablist" aria-label="Settings sections">
          {TABS.map(t => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => go(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>
      {tab === 'health' && <HealthTab onGo={go} />}
      {tab === 'locations' && <LocationsTab />}
      {tab === 'characters' && <CharactersTab />}
      {tab === 'general' && <GeneralTab />}
    </section>
  )
}
