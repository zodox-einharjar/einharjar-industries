'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTopbarActions } from '@/lib/topbar-context'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarketListing {
  id: number
  order_id: number
  type_id: number
  item_name: string
  location_name: string
  location_known: boolean
  qty_total: number
  qty_remaining: number
  list_price: number
  market_low: number | null
  is_undercut: boolean
  has_inventory: boolean
  profit_per_unit: number | null
  jita_buy: number | null
  jita_sell: number | null
  jita_split: number | null
  issued: string
  expires: string
  hours_remaining: number
  last_synced: string
  status: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function iska(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtHours(h: number): string {
  if (h >= 24) return `${Math.floor(h / 24)}d ${Math.floor(h % 24)}h`
  return `${Math.floor(h)}h`
}

function fmtSynced(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return d.toLocaleDateString()
}

const BTN_SM         = 'px-3 py-1 text-[12px] border border-wire text-muted hover:text-primary hover:border-secondary rounded transition-colors'
const BTN_SM_PRIMARY = 'px-3 py-1 text-[12px] border border-accent text-accent hover:bg-accent hover:text-canvas rounded transition-colors disabled:opacity-40 disabled:pointer-events-none'
const BTN_SM_AMBER   = 'px-2 py-0.5 text-[11px] border border-eve-amber text-eve-amber hover:bg-eve-amber hover:text-canvas rounded transition-colors'

const TH = 'px-3 py-2 text-[10px] text-muted font-semibold uppercase tracking-wider whitespace-nowrap'

// ── Add to inventory modal ────────────────────────────────────────────────────

type PriceMode = 'buy' | 'split' | 'sell' | 'manual'

function AddInventoryModal({ listing, onClose, onAdded }: {
  listing: MarketListing
  onClose: () => void
  onAdded: () => void
}) {
  const [mode, setMode] = useState<PriceMode>(() => {
    if (listing.jita_split != null) return 'split'
    if (listing.jita_sell != null) return 'sell'
    return 'manual'
  })
  const [manualPrice, setManualPrice] = useState('')
  const [qty, setQty] = useState(String(listing.qty_remaining))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const PRICE_OPTIONS: { key: PriceMode; label: string; value: number | null }[] = [
    { key: 'buy',    label: 'Jita buy',   value: listing.jita_buy   },
    { key: 'split',  label: 'Jita split', value: listing.jita_split },
    { key: 'sell',   label: 'Jita sell',  value: listing.jita_sell  },
    { key: 'manual', label: 'Manual',     value: null               },
  ]

  const resolvedPrice = mode === 'manual'
    ? parseFloat(manualPrice.replace(/[\s,]/g, '')) || 0
    : (PRICE_OPTIONS.find(o => o.key === mode)?.value ?? 0)

  const resolvedQty = parseInt(qty) || 0

  async function handleAdd() {
    if (resolvedPrice <= 0 || resolvedQty <= 0) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/market-listings/${listing.id}/add-inventory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unit_cost: resolvedPrice, qty: resolvedQty }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail ?? 'Failed to add')
      }
      onAdded()
      onClose()
    } catch (e: any) {
      setError(e.message || 'Failed to add to inventory.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-surface border border-wire rounded-lg w-full max-w-md flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-wire">
          <span className="text-[14px] font-semibold text-primary">Add to Inventory</span>
          <button onClick={onClose} className="text-muted hover:text-primary text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Item info */}
          <div className="rounded bg-canvas border border-wire px-3 py-2.5 space-y-1">
            <div className="text-[13px] text-primary font-medium">{listing.item_name}</div>
            <div className="text-[11px] text-muted">{listing.location_name}</div>
          </div>

          {!listing.location_known && (
            <p className="text-[12px] text-eve-amber">
              This location isn&apos;t registered in the app. Add it in Settings → Locations first.
            </p>
          )}

          {/* Qty */}
          <div>
            <label className="block text-[11px] text-muted mb-1.5">Quantity</label>
            <input
              type="text"
              inputMode="numeric"
              value={qty}
              onChange={e => setQty(e.target.value)}
              className="w-full bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] font-mono text-primary focus:outline-none focus:border-accent"
              placeholder={String(listing.qty_remaining)}
            />
            <p className="text-[11px] text-faint mt-1">{listing.qty_remaining.toLocaleString()} currently on market</p>
          </div>

          {/* Unit cost */}
          <div>
            <label className="block text-[11px] text-muted mb-1.5">Unit cost (cost basis)</label>
            <div className="flex gap-1.5 flex-wrap mb-2">
              {PRICE_OPTIONS.map(opt => (
                <button
                  key={opt.key}
                  onClick={() => setMode(opt.key)}
                  disabled={opt.key !== 'manual' && opt.value == null}
                  className={`px-2.5 py-1 text-[12px] rounded border transition-colors disabled:opacity-30 disabled:pointer-events-none ${
                    mode === opt.key
                      ? 'border-accent text-accent bg-accent/10'
                      : 'border-wire text-muted hover:text-secondary'
                  }`}
                >
                  {opt.label}
                  {opt.value != null && (
                    <span className="ml-1 text-faint">{iska(opt.value)}</span>
                  )}
                </button>
              ))}
            </div>
            {mode === 'manual' && (
              <input
                type="text"
                inputMode="numeric"
                value={manualPrice}
                onChange={e => setManualPrice(e.target.value)}
                placeholder="0.00"
                autoFocus
                className="w-full bg-canvas border border-wire rounded px-3 py-1.5 text-[13px] font-mono text-primary focus:outline-none focus:border-accent"
              />
            )}
            {mode !== 'manual' && resolvedPrice > 0 && (
              <div className="text-[12px] font-mono text-secondary mt-1">{iska(resolvedPrice)} ISK/unit</div>
            )}
          </div>

          {error && <p className="text-[12px] text-eve-red">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-wire">
          <button onClick={onClose} className={BTN_SM}>Cancel</button>
          <button
            onClick={handleAdd}
            disabled={saving || resolvedPrice <= 0 || resolvedQty <= 0 || !listing.location_known}
            className={BTN_SM_PRIMARY}
          >
            {saving ? 'Adding…' : `Add ${resolvedQty > 0 ? resolvedQty.toLocaleString() + '×' : ''} to inventory`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

function fmtEsiExpiry(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  const now = new Date()
  const diffMs = d.getTime() - now.getTime()
  const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (diffMs <= 0) return null
  const diffMin = Math.ceil(diffMs / 60000)
  return `ESI cache expires at ${timeStr} (in ${diffMin}m)`
}

export function MarketOrdersClient() {
  const { setActions } = useTopbarActions()
  const [listings, setListings] = useState<MarketListing[]>([])
  const [esiExpires, setEsiExpires] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<{ found: number; new: number } | null>(null)
  const [cancellingId, setCancellingId] = useState<number | null>(null)
  const [addInventoryFor, setAddInventoryFor] = useState<MarketListing | null>(null)

  const load = useCallback(async () => {
    try {
      const [listRes, settingsRes] = await Promise.all([
        fetch('/api/market-listings'),
        fetch('/api/settings'),
      ])
      if (!listRes.ok) throw new Error()
      setListings(await listRes.json())
      if (settingsRes.ok) {
        const s = await settingsRes.json()
        setEsiExpires(s.orders_esi_expires ?? null)
      }
      setLoadError(null)
    } catch {
      setLoadError('Failed to load listings.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function syncNow() {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/market-listings/sync', { method: 'POST' })
      if (!res.ok) throw new Error()
      const data = await res.json()
      await load()
      setSyncResult({ found: data.orders_found, new: data.orders_new })
      setTimeout(() => setSyncResult(null), 8000)
    } catch {
      setSyncError('Sync failed — check Docker logs for details.')
      setTimeout(() => setSyncError(null), 10000)
    } finally {
      setSyncing(false)
    }
  }

  async function cancelListing(id: number) {
    setCancellingId(id)
    try {
      await fetch(`/api/market-listings/${id}`, { method: 'DELETE' })
      setListings(prev => prev.filter(l => l.id !== id))
    } catch {
      setError('Failed to cancel listing.')
    } finally {
      setCancellingId(null)
    }
  }

  useEffect(() => {
    setActions(
      <button onClick={syncNow} disabled={syncing} className={BTN_SM_PRIMARY}>
        {syncing ? 'Syncing…' : 'Sync now'}
      </button>
    )
    return () => setActions(null)
  }, [setActions, syncing])

  const undercut = listings.filter(l => l.is_undercut)
  const noInventory = listings.filter(l => !l.has_inventory)
  const lastSynced = listings.length > 0
    ? listings.reduce((latest, l) => l.last_synced > latest ? l.last_synced : latest, listings[0].last_synced)
    : null

  if (loading) return <p className="text-muted text-[13px]">Loading…</p>
  if (loadError) return <p className="text-eve-red text-[13px]">{loadError}</p>

  if (listings.length === 0) return (
    <>
      <div className="rounded border border-wire px-4 py-16 text-center space-y-3">
        <p className="text-[14px] text-secondary">No active sell orders found.</p>
        <p className="text-[12px] text-muted max-w-md mx-auto">
          Place sell orders in EVE, then click <strong className="text-secondary">Sync now</strong> to pull them from ESI.
          Orders are also synced automatically every 5 minutes.
        </p>
        <button onClick={syncNow} disabled={syncing} className={`${BTN_SM_PRIMARY} mt-2`}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
        {syncResult !== null && (
          <p className={`text-[12px] ${syncResult.found > 0 ? 'text-eve-green' : 'text-eve-amber'}`}>
            {syncResult.found > 0
              ? `Found ${syncResult.found} order${syncResult.found !== 1 ? 's' : ''}`
              : 'No orders found — check Settings → ESI / Auth to verify polling is configured'
            }
          </p>
        )}
        {syncError && <p className="text-[12px] text-eve-red">{syncError}</p>}
      </div>
    </>
  )

  return (
    <>
      <div className="space-y-4">
        {/* Summary bar */}
        <div className="flex items-center gap-4 text-[12px] text-muted flex-wrap">
          <span>{listings.length} active listing{listings.length !== 1 ? 's' : ''}</span>
          {undercut.length > 0 && (
            <span className="text-eve-red font-medium">{undercut.length} undercut</span>
          )}
          {noInventory.length > 0 && (
            <span className="text-eve-amber font-medium">{noInventory.length} not in inventory</span>
          )}
          {syncResult !== null && (
            <span className={syncResult.found > 0 ? 'text-eve-green font-medium' : 'text-eve-amber'}>
              {syncResult.found > 0
                ? `Sync complete — ${syncResult.found} order${syncResult.found !== 1 ? 's' : ''} found${syncResult.new > 0 ? ` (${syncResult.new} new)` : ''}`
                : 'Sync complete — no orders found. Check Settings → ESI / Auth'
              }
            </span>
          )}
          {syncError && (
            <span className="text-eve-red font-medium">{syncError}</span>
          )}
          <span className="ml-auto flex items-center gap-3">
            {fmtEsiExpiry(esiExpires) && (
              <span className="text-faint">{fmtEsiExpiry(esiExpires)}</span>
            )}
            {lastSynced && <span>Last synced {fmtSynced(lastSynced)}</span>}
          </span>
        </div>

        {/* Table */}
        <div className="border border-wire rounded overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-surface-hi border-b border-wire">
                  <th className={`${TH} text-left`}>Item</th>
                  <th className={`${TH} text-left`}>Location</th>
                  <th className={`${TH} text-right`}>Listed</th>
                  <th className={`${TH} text-right`}>Remaining</th>
                  <th className={`${TH} text-right`}>List price</th>
                  <th className={`${TH} text-right`}>Market low</th>
                  <th className={`${TH} text-right`}>Jita sell</th>
                  <th className={`${TH} text-right`}>Profit/u</th>
                  <th className={`${TH} text-right`}>Expires</th>
                  <th className={`${TH} text-right`}>Synced</th>
                  <th className={TH} />
                </tr>
              </thead>
              <tbody>
                {listings.map(l => (
                  <tr
                    key={l.id}
                    className={`border-t border-wire hover:bg-surface/40 transition-colors ${
                      l.is_undercut ? 'bg-eve-red/5' : !l.has_inventory ? 'bg-eve-amber/5' : ''
                    }`}
                  >
                    <td className="px-3 py-2 text-primary font-medium max-w-[200px]">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="truncate">{l.item_name}</span>
                        {l.is_undercut && (
                          <span className="text-[10px] text-eve-red font-semibold uppercase tracking-wide flex-shrink-0">Undercut</span>
                        )}
                        {!l.has_inventory && (
                          <span className="text-[10px] text-eve-amber font-semibold uppercase tracking-wide flex-shrink-0">Not in inventory</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-secondary max-w-[160px] truncate" title={l.location_name}>
                      {l.location_name}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-muted">{l.qty_total.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono text-secondary">{l.qty_remaining.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono text-secondary">{iska(l.list_price)}</td>
                    <td className={`px-3 py-2 text-right font-mono ${
                      l.is_undercut ? 'text-eve-red font-medium' : 'text-secondary'
                    }`}>
                      {iska(l.market_low)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-muted">
                      {iska(l.jita_sell)}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${
                      l.profit_per_unit == null ? 'text-faint' : l.profit_per_unit > 0 ? 'text-eve-green' : 'text-eve-red'
                    }`}>
                      {l.profit_per_unit != null ? iska(l.profit_per_unit) : '—'}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono ${
                      l.hours_remaining < 24 ? 'text-eve-amber' : 'text-muted'
                    }`}>
                      {fmtHours(l.hours_remaining)}
                    </td>
                    <td className="px-3 py-2 text-right text-faint">{fmtSynced(l.last_synced)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        {!l.has_inventory && (
                          <button
                            onClick={() => setAddInventoryFor(l)}
                            className={BTN_SM_AMBER}
                            title="Add this item to inventory"
                          >
                            Add to inventory
                          </button>
                        )}
                        <button
                          onClick={() => cancelListing(l.id)}
                          disabled={cancellingId === l.id}
                          className="text-[11px] text-muted hover:text-eve-red transition-colors disabled:opacity-40"
                          title="Mark as cancelled"
                        >
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-[11px] text-faint">
          Orders sync every 5 minutes from ESI. Wallet transactions are matched automatically to record sales.
          Use &quot;Cancel&quot; only for orders you pulled manually before ESI detected it.
        </p>
      </div>

      {addInventoryFor && (
        <AddInventoryModal
          listing={addInventoryFor}
          onClose={() => setAddInventoryFor(null)}
          onAdded={() => { load(); setAddInventoryFor(null) }}
        />
      )}
    </>
  )
}
