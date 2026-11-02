'use client'

import Link from 'next/link'
import { MarketDetailClient, type MarketItemDetail } from '../../../../(shell)/market/[type_id]/MarketDetailClient'
import { isk } from '../../_shared/doctrines'

interface PriceRow {
  location_id: number; location_name: string; is_jita: boolean
  sell: number | null; sell_units: number; buy: number | null; buy_units: number
}
interface StockRow {
  location_id: number | null; location_name: string
  qty: number; reserved: number; on_market: number
  avg_cost: number | null; value_jita_sell: number | null
}
interface ListingRow {
  order_id: number; location_name: string; qty_remaining: number; qty_total: number; price: number; expires: string
}
interface FitRow {
  id: number; name: string; hull: boolean; qty_per_fit: number
  doctrines: { id: number; name: string; target_qty: number }[]
}
interface ProjectRow {
  id: number; name: string; status: string; role: 'material' | 'output'; qty: number; reserved: number | null
}
export interface ItemOverview {
  type_id: number; name: string; group: string; on_market: boolean; volume_m3: number | null
  prices: PriceRow[]; stock: StockRow[]; listings: ListingRow[]; fits: FitRow[]; projects: ProjectRow[]
}

// Fixed locale so the server render and the browser agree (avoids hydration errors).
const n = (v: number) => v.toLocaleString('en-US')
const STATUS: Record<string, string> = { planning: 'Planning', in_progress: 'In progress', complete: 'Complete' }

function copy(text: string) {
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text); return }
  const el = document.createElement('textarea')
  el.value = text; el.style.cssText = 'position:fixed;opacity:0'
  document.body.appendChild(el); el.select(); document.execCommand('copy'); el.remove()
}

export function TrialItem({ item, market, locations }: {
  item: ItemOverview
  market: MarketItemDetail | null
  locations: { id: number; name: string }[]
}) {
  const held = item.stock.reduce((s, r) => s + r.qty, 0)
  const jita = item.prices.find(p => p.is_jita)
  const usedIn = item.fits.length + item.projects.length

  return (
    <section className="v2-item" aria-labelledby="item-title">
      <header className="v2-item-head">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`https://images.evetech.net/types/${item.type_id}/icon?size=64`} alt="" width={56} height={56} />
        <div>
          <h2 id="item-title">{item.name}</h2>
          <p>
            {item.group}
            {item.volume_m3 != null && <> · {n(item.volume_m3)} m³</>}
            {' · '}
            <button className="v2-linkish" onClick={() => copy(item.name)} title="Copy the name">Copy name</button>
          </p>
        </div>
        <dl className="v2-item-facts">
          <div><dt>We hold</dt><dd>{n(held)}</dd></div>
          <div><dt>Jita sell</dt><dd>{isk(jita?.sell)}</dd></div>
          <div><dt>Jita buy</dt><dd>{isk(jita?.buy)}</dd></div>
        </dl>
      </header>

      <div className="v2-item-grid">
        <div className="v2-item-block">
          <h3>Prices</h3>
          <div className="v2-table-wrap">
            <table className="v2-table flush">
              <thead><tr><th>Location</th><th className="num">Sell low</th><th className="num">On sale</th><th className="num">Buy high</th></tr></thead>
              <tbody>
                {item.prices.map(p => (
                  <tr key={p.location_id} className={p.sell == null && p.buy == null ? 'off' : undefined}>
                    <td>{p.location_name}</td>
                    <td className="num">{isk(p.sell)}</td>
                    <td className="num muted">{p.sell_units ? n(p.sell_units) : '–'}</td>
                    <td className="num">{isk(p.buy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!item.on_market && <p className="v2-empty">This item can't be traded on the market.</p>}
        </div>

        <div className="v2-item-block">
          <h3>Our stock</h3>
          {item.stock.length === 0 ? (
            <p className="v2-empty">None in inventory.</p>
          ) : (
            <div className="v2-table-wrap">
              <table className="v2-table flush">
                <thead><tr><th>Location</th><th className="num">Held</th><th className="num">In projects</th><th className="num">Listed</th><th className="num">Avg cost</th><th className="num">At Jita sell</th></tr></thead>
                <tbody>
                  {item.stock.map(s => (
                    <tr key={s.location_id ?? 'none'}>
                      <td>
                        {s.location_id != null
                          ? <Link className="name" href={`/v2/inventory?location=${s.location_id}`}>{s.location_name}</Link>
                          : s.location_name}
                      </td>
                      <td className="num">{n(s.qty)}</td>
                      <td className="num muted">{s.reserved ? n(s.reserved) : '–'}</td>
                      <td className="num muted">{s.on_market ? n(s.on_market) : '–'}</td>
                      <td className="num">{isk(s.avg_cost)}</td>
                      <td className="num">{isk(s.value_jita_sell)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {item.listings.length > 0 && (
            <>
              <h4>Our sell orders</h4>
              <div className="v2-table-wrap">
                <table className="v2-table flush">
                  <thead><tr><th>Location</th><th className="num">Left</th><th className="num">Price</th><th className="num">Expires</th></tr></thead>
                  <tbody>
                    {item.listings.map(l => (
                      <tr key={l.order_id}>
                        <td>{l.location_name}</td>
                        <td className="num">{n(l.qty_remaining)} <span className="muted">of {n(l.qty_total)}</span></td>
                        <td className="num">{isk(l.price)}</td>
                        <td className="num muted">{l.expires.slice(0, 10)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="v2-item-block wide">
          <h3>Used in</h3>
          {usedIn === 0 ? (
            <p className="v2-empty">Not part of any fit or open industry project.</p>
          ) : (
            <div className="v2-table-wrap">
              <table className="v2-table flush">
                <thead><tr><th>Fit or project</th><th>Doctrines / status</th><th className="num">Qty</th></tr></thead>
                <tbody>
                  {item.fits.map(f => (
                    <tr key={`f${f.id}`}>
                      <td><Link className="name" href={`/doctrines/fits/${f.id}`}>{f.name}</Link> <span className="muted">{f.hull ? 'hull' : 'fit'}</span></td>
                      <td className="muted">
                        {f.doctrines.length === 0 ? 'In no doctrine' : f.doctrines.map(d => `${d.name} (target ${d.target_qty})`).join(', ')}
                      </td>
                      <td className="num">{n(f.qty_per_fit)} <span className="muted">per fit</span></td>
                    </tr>
                  ))}
                  {item.projects.map(p => (
                    <tr key={`p${p.id}${p.role}`}>
                      <td><Link className="name" href={`/v2/industry/${p.id}`}>{p.name}</Link> <span className="muted">{p.role === 'output' ? 'makes it' : 'needs it'}</span></td>
                      <td className="muted">{STATUS[p.status] ?? p.status}</td>
                      <td className="num">
                        {n(p.qty)}
                        {p.role === 'material' && p.reserved != null && <span className="muted"> ({n(p.reserved)} reserved)</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {market && item.on_market && (
        <div className="v2-port v2-item-market">
          <MarketDetailClient initialItem={market} locations={locations} embedded />
        </div>
      )}
    </section>
  )
}
