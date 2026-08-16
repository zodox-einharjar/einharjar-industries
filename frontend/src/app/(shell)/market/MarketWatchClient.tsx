'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TrackedItem {
  type_id: number
  name: string
  source: 'manual' | 'doctrine'
  added_at: string
  jita_sell: number | null
}

interface SearchResult {
  type_id: number
  name: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function iska(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  let val: number, suffix: string
  if (abs >= 1e9)      { val = n / 1e9; suffix = 'B' }
  else if (abs >= 1e6) { val = n / 1e6; suffix = 'M' }
  else if (abs >= 1e3) { val = n / 1e3; suffix = 'K' }
  else                 { return parseFloat(n.toPrecision(4)).toLocaleString() }
  return `${parseFloat(val.toPrecision(4))}${suffix}`
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const TH = 'px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider whitespace-nowrap'
const BTN_SM = 'px-3 py-1 text-[12px] border border-wire text-muted hover:text-primary hover:border-secondary rounded transition-colors'
const BTN_SM_PRIMARY = 'px-3 py-1 text-[12px] border border-accent text-accent hover:bg-accent hover:text-canvas rounded transition-colors'

// ── Add-item search box ──────────────────────────────────────────────────────

function ItemSearchBox({ onAdd, onClose }: { onAdd: (type_id: number) => void; onClose: () => void }) {
  const [value, setValue] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])

  async function onSearch(q: string) {
    setValue(q)
    if (q.length < 2) { setResults([]); return }
    const res = await fetch(`/api/industry/search/items?q=${encodeURIComponent(q)}`)
    if (res.ok) setResults(await res.json())
  }

  return (
    <div className="mb-3 bg-canvas border border-wire rounded-lg p-3 space-y-2">
      <div className="flex gap-2">
        <input
          autoFocus
          value={value}
          onChange={e => onSearch(e.target.value)}
          className="flex-1 bg-surface border border-wire rounded px-3 py-1.5 text-[13px] text-primary focus:outline-none focus:border-accent"
          placeholder="Search item…"
        />
        <button onClick={onClose} className="text-faint hover:text-primary text-[12px] px-2">Cancel</button>
      </div>
      {results.length > 0 && (
        <div className="max-h-48 overflow-y-auto border border-wire rounded divide-y divide-wire">
          {results.map(r => (
            <div key={r.type_id} className="flex items-center justify-between px-3 py-1.5 hover:bg-surface-hi">
              <span className="text-[13px] text-primary">{r.name}</span>
              <button onClick={() => onAdd(r.type_id)} className="text-[11px] text-accent hover:underline">Add</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function MarketWatchClient() {
  const [items, setItems] = useState<TrackedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/market-watch')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(setItems)
      .catch(() => setError('Failed to load watchlist.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function addItem(type_id: number) {
    await fetch('/api/market-watch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type_id }),
    })
    setAdding(false)
    load()
  }

  async function removeItem(type_id: number) {
    await fetch(`/api/market-watch/${type_id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold tracking-[0.1em] text-faint uppercase">Tracked items</div>
        <button onClick={() => setAdding(!adding)} className={BTN_SM_PRIMARY}>+ Add item</button>
      </div>

      {adding && <ItemSearchBox onAdd={addItem} onClose={() => setAdding(false)} />}

      {loading ? (
        <div className="h-40 bg-surface border border-wire rounded animate-pulse" />
      ) : error ? (
        <div className="bg-surface border border-wire rounded p-8 text-center text-muted text-[13px]">{error}</div>
      ) : items.length === 0 ? (
        <div className="bg-surface border border-wire rounded p-8 text-center text-muted text-[13px]">
          Nothing tracked yet. Items used in doctrine fits are tracked automatically — or add one manually above.
        </div>
      ) : (
        <div className="border border-wire rounded overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-surface-hi border-b border-wire">
                  <th className={`${TH} text-left`}>Item</th>
                  <th className={`${TH} text-left`}>Source</th>
                  <th className={`${TH} text-right`}>Jita Sell</th>
                  <th className={`${TH} text-left`}>Added</th>
                  <th className={TH}></th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.type_id} className="border-t border-wire-dim hover:bg-canvas transition-colors">
                    <td className="px-3 py-2">
                      <Link href={`/market/${item.type_id}`} className="text-primary hover:text-accent transition-colors">
                        {item.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide border ${
                        item.source === 'doctrine' ? 'border-accent text-accent' : 'border-wire text-muted'
                      }`}>
                        {item.source}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-secondary">{iska(item.jita_sell)}</td>
                    <td className="px-3 py-2 text-faint">{fmtDate(item.added_at)}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => removeItem(item.type_id)} className={BTN_SM}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
