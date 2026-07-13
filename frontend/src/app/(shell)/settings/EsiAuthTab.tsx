'use client'

import Image from 'next/image'
import { useState, useEffect } from 'react'

interface EVECharacter {
  character_id: number
  character_name: string
  corporation_id: number | null
  corp_name: string | null
  portrait_url: string
  token_valid: boolean
  expires_at: string
  scopes: string[]
}

interface PollSettings {
  main_character_id: number | null
  poll_char_orders: number[]
  poll_corp_orders: number[]
  poll_char_wallet: number[]
  poll_corp_wallet: number[]
  poll_char_contracts: number[]
  poll_corp_contracts: number[]
}

const HAS_SCOPE = (char: EVECharacter, scope: string) => char.scopes.includes(scope)

const SCOPE_CHAR_ORDERS    = 'esi-markets.read_character_orders.v1'
const SCOPE_CORP_ORDERS    = 'esi-markets.read_corporation_orders.v1'
const SCOPE_CHAR_WALLET    = 'esi-wallet.read_character_wallet.v1'
const SCOPE_CORP_WALLET    = 'esi-wallet.read_corporation_wallets.v1'
const SCOPE_CHAR_CONTRACTS = 'esi-contracts.read_character_contracts.v1'
const SCOPE_CORP_CONTRACTS = 'esi-contracts.read_corporation_contracts.v1'

function TokenPill({ valid }: { valid: boolean }) {
  return (
    <span className={[
      'text-[11px] px-1.5 py-0.5 rounded border font-medium flex-shrink-0',
      valid ? 'text-eve-green border-eve-green' : 'text-eve-red border-eve-red',
    ].join(' ')}>
      {valid ? 'Valid' : 'Expired'}
    </span>
  )
}

function formatExpiry(iso: string): string {
  const d = new Date(iso)
  const ms = d.getTime() - Date.now()
  if (ms < 0) return 'Expired'
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return 'Expires soon'
  if (h < 24) return `Expires in ${h}h`
  return `Expires ${d.toLocaleDateString()}`
}

function Toggle({ checked, disabled, onChange, label }: {
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <label className={`flex items-center gap-2 cursor-pointer select-none ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <div
        onClick={() => onChange(!checked)}
        className={`relative w-8 h-4 rounded-full transition-colors flex-shrink-0 ${checked ? 'bg-accent' : 'bg-wire'}`}
      >
        <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </div>
      <span className="text-[12px] text-secondary">{label}</span>
    </label>
  )
}

export function EsiAuthTab() {
  const [chars, setChars]           = useState<EVECharacter[]>([])
  const [pollSettings, setPollSettings] = useState<PollSettings>({
    main_character_id: null,
    poll_char_orders: [],
    poll_corp_orders: [],
    poll_char_wallet: [],
    poll_corp_wallet: [],
    poll_char_contracts: [],
    poll_corp_contracts: [],
  })
  const [loading, setLoading]       = useState(true)
  const [saving, setSaving]         = useState(false)
  const [saved, setSaved]           = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [expanded, setExpanded]     = useState<Set<number>>(new Set())

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true); setError(null)
    try {
      const [rChars, rSettings] = await Promise.all([
        fetch('/api/auth/characters'),
        fetch('/api/settings'),
      ])
      if (!rChars.ok || !rSettings.ok) throw new Error()
      const [charsData, settingsData] = await Promise.all([rChars.json(), rSettings.json()])
      setChars(charsData)
      setPollSettings({
        main_character_id: settingsData.main_character_id ?? null,
        poll_char_orders:     settingsData.poll_char_orders     ?? [],
        poll_corp_orders:     settingsData.poll_corp_orders     ?? [],
        poll_char_wallet:     settingsData.poll_char_wallet     ?? [],
        poll_corp_wallet:     settingsData.poll_corp_wallet     ?? [],
        poll_char_contracts:  settingsData.poll_char_contracts  ?? [],
        poll_corp_contracts:  settingsData.poll_corp_contracts  ?? [],
      })
    } catch {
      setError('Failed to load characters.')
    } finally {
      setLoading(false)
    }
  }

  function toggleExpand(id: number) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function handleRevoke(characterId: number, name: string) {
    if (!confirm(`Revoke access for ${name}? They will be logged out on next request.`)) return
    const r = await fetch(`/api/auth/characters/${characterId}`, { method: 'DELETE' })
    if (r.ok || r.status === 204) setChars(prev => prev.filter(c => c.character_id !== characterId))
  }

  function toggleId(key: keyof PollSettings, id: number, on: boolean) {
    setPollSettings(prev => {
      const list = prev[key] as number[]
      return {
        ...prev,
        [key]: on ? [...list, id] : list.filter(x => x !== id),
      }
    })
  }

  async function saveSettings() {
    setSaving(true); setError(null)
    try {
      const r = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pollSettings),
      })
      if (!r.ok) throw new Error()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Failed to save settings.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="text-muted text-[13px]">Loading…</p>
  if (error)   return <p className="text-eve-red text-[13px]">{error}</p>

  return (
    <div className="space-y-8">

      {/* ── Characters ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-semibold text-muted uppercase tracking-wider">Characters</span>
          <div className="flex gap-2">
            <a href="/auth/login?type=character"
              className="text-[12px] px-3 py-1 border border-accent text-accent rounded hover:bg-accent hover:text-canvas transition-colors">
              + Character
            </a>
            <a href="/auth/login?type=corporation"
              className="text-[12px] px-3 py-1 border border-wire text-muted rounded hover:text-primary hover:border-secondary transition-colors">
              + Character + Corp
            </a>
          </div>
        </div>

        <div className="rounded border border-wire overflow-hidden">
          {chars.length === 0 && (
            <div className="px-4 py-8 text-center text-muted text-[13px]">No characters authenticated.</div>
          )}
          {chars.map(char => {
            const isMain = pollSettings.main_character_id === char.character_id
            const hasCorpId = !!char.corporation_id

            return (
              <div key={char.character_id} className="border-t border-wire first:border-0">
                {/* Main row */}
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-surface-hi">
                  <div className="relative flex-shrink-0">
                    <Image
                      src={char.portrait_url}
                      alt={char.character_name}
                      width={36}
                      height={36}
                      className="rounded"
                      unoptimized
                    />
                    {isMain && (
                      <div className="absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full bg-accent border-2 border-surface" title="Main character" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] text-primary font-medium truncate">{char.character_name}</span>
                      {isMain && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium flex-shrink-0">Main</span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted">
                      {char.corp_name ?? 'Unknown corp'} · {formatExpiry(char.expires_at)}
                    </div>
                  </div>

                  <TokenPill valid={char.token_valid} />

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {!isMain && (
                      <button
                        onClick={() => setPollSettings(prev => ({ ...prev, main_character_id: char.character_id }))}
                        className="text-[12px] px-2.5 py-1 border border-wire text-muted rounded hover:border-accent hover:text-accent transition-colors">
                        Set main
                      </button>
                    )}
                    {!char.token_valid && (
                      <a
                        href={`/auth/login?type=${char.scopes.includes(SCOPE_CORP_ORDERS) ? 'corporation' : 'character'}`}
                        className="text-[12px] px-2.5 py-1 border border-accent text-accent rounded hover:bg-accent hover:text-canvas transition-colors">
                        Re-auth
                      </a>
                    )}
                    <button
                      onClick={() => handleRevoke(char.character_id, char.character_name)}
                      className="text-[12px] px-2.5 py-1 border border-wire text-muted rounded hover:border-eve-red hover:text-eve-red transition-colors">
                      Revoke
                    </button>
                    <button
                      onClick={() => toggleExpand(char.character_id)}
                      className="text-[11px] w-7 h-7 flex items-center justify-center border border-wire text-muted rounded hover:text-secondary transition-colors"
                      aria-label="Toggle details">
                      {expanded.has(char.character_id) ? '▲' : '▼'}
                    </button>
                  </div>
                </div>

                {/* Expanded: poll toggles + scopes */}
                {expanded.has(char.character_id) && (
                  <div className="px-4 pb-4 pt-3 border-t border-wire bg-canvas space-y-4">

                    {/* Poll toggles */}
                    <div>
                      <div className="text-[10px] font-semibold text-faint uppercase tracking-wider mb-2">
                        Polling
                      </div>
                      <div className="grid grid-cols-2 gap-x-8 gap-y-2">
                        <Toggle
                          label="Character orders"
                          checked={pollSettings.poll_char_orders.includes(char.character_id)}
                          disabled={!HAS_SCOPE(char, SCOPE_CHAR_ORDERS)}
                          onChange={on => toggleId('poll_char_orders', char.character_id, on)}
                        />
                        <Toggle
                          label="Corp orders"
                          checked={pollSettings.poll_corp_orders.includes(char.character_id)}
                          disabled={!HAS_SCOPE(char, SCOPE_CORP_ORDERS) || !hasCorpId}
                          onChange={on => toggleId('poll_corp_orders', char.character_id, on)}
                        />
                        <Toggle
                          label="Character wallet"
                          checked={pollSettings.poll_char_wallet.includes(char.character_id)}
                          disabled={!HAS_SCOPE(char, SCOPE_CHAR_WALLET)}
                          onChange={on => toggleId('poll_char_wallet', char.character_id, on)}
                        />
                        <Toggle
                          label="Corp wallet (master)"
                          checked={pollSettings.poll_corp_wallet.includes(char.character_id)}
                          disabled={!HAS_SCOPE(char, SCOPE_CORP_WALLET) || !hasCorpId}
                          onChange={on => toggleId('poll_corp_wallet', char.character_id, on)}
                        />
                        <Toggle
                          label="Character contracts"
                          checked={pollSettings.poll_char_contracts.includes(char.character_id)}
                          disabled={!HAS_SCOPE(char, SCOPE_CHAR_CONTRACTS)}
                          onChange={on => toggleId('poll_char_contracts', char.character_id, on)}
                        />
                        <Toggle
                          label="Corp contracts"
                          checked={pollSettings.poll_corp_contracts.includes(char.character_id)}
                          disabled={!HAS_SCOPE(char, SCOPE_CORP_CONTRACTS) || !hasCorpId}
                          onChange={on => toggleId('poll_corp_contracts', char.character_id, on)}
                        />
                      </div>
                      {!hasCorpId && (
                        <p className="text-[11px] text-faint mt-2">
                          Corp polling unavailable — re-authenticate to fetch corporation info.
                        </p>
                      )}
                    </div>

                    {/* Scopes */}
                    <div>
                      <div className="text-[10px] font-semibold text-faint uppercase tracking-wider mb-2">
                        Granted Scopes
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {char.scopes.length === 0
                          ? <span className="text-[11px] text-faint">No scopes recorded.</span>
                          : char.scopes.map(s => (
                              <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-surface border border-wire text-muted font-mono">
                                {s}
                              </span>
                            ))
                        }
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Corporations ── */}
      {(() => {
        // Derive unique corps from characters that authenticated with corp scopes
        const CORP_SCOPE_INDICATORS = [SCOPE_CORP_ORDERS, SCOPE_CORP_WALLET,
          'esi-assets.read_corporation_assets.v1', 'esi-industry.read_corporation_jobs.v1']
        const corpChars = chars.filter(c =>
          c.corporation_id && c.corp_name &&
          CORP_SCOPE_INDICATORS.some(s => c.scopes.includes(s))
        )
        const byCorpId = new Map<number, { corp_name: string; corporation_id: number; chars: EVECharacter[] }>()
        for (const c of corpChars) {
          const existing = byCorpId.get(c.corporation_id!)
          if (existing) existing.chars.push(c)
          else byCorpId.set(c.corporation_id!, { corp_name: c.corp_name!, corporation_id: c.corporation_id!, chars: [c] })
        }
        const corps = [...byCorpId.values()]

        return (
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-semibold text-muted uppercase tracking-wider">Corporations</span>
            </div>

            <div className="rounded border border-wire overflow-hidden">
              {corps.length === 0 ? (
                <div className="px-4 py-8 text-center space-y-2">
                  <p className="text-muted text-[13px]">No corporations added.</p>
                  <p className="text-faint text-[12px]">
                    Authenticate a character with corporation roles using the{' '}
                    <a href="/auth/login?type=corporation" className="text-accent hover:underline">+ Corporation</a>
                    {' '}button above.
                  </p>
                </div>
              ) : corps.map(corp => (
                <div key={corp.corporation_id} className="border-t border-wire first:border-0 flex items-center gap-3 px-4 py-3">
                  <Image
                    src={`https://images.evetech.net/corporations/${corp.corporation_id}/logo?size=64`}
                    alt={corp.corp_name}
                    width={36}
                    height={36}
                    className="rounded flex-shrink-0"
                    unoptimized
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-primary font-medium truncate">{corp.corp_name}</div>
                    <div className="text-[11px] text-muted">
                      via {corp.chars.map(c => c.character_name).join(', ')}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Save button */}
      <div className="flex items-center gap-3">
        <button
          onClick={saveSettings}
          disabled={saving}
          className={`text-[13px] px-4 py-1.5 rounded border transition-colors ${
            saved
              ? 'border-eve-green text-eve-green'
              : 'border-accent text-accent hover:bg-accent hover:text-canvas disabled:opacity-40 disabled:pointer-events-none'
          }`}
        >
          {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save Settings'}
        </button>
        {error && <span className="text-[12px] text-eve-red">{error}</span>}
      </div>

      <p className="text-[11px] text-faint -mt-2">
        Polling toggles control which characters and corporations are queried for orders, wallet transactions, and contracts.
        When no toggles are enabled for a category, all characters with the required scope are polled automatically.
      </p>

    </div>
  )
}
