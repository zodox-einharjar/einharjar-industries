// Pricing rules for the To list page. Kept free of React so the arithmetic is easy to check.

export interface PriceRange { minPct: number; maxPct: number }

export interface PricingInput {
  cost: number              // ISK per unit; 0 when the stock has no known cost
  low: number | null        // lowest sell order at the location
  ownPrices: number[]       // our active sell orders there
  feeFrac: number           // broker + sales tax + SCC, as a fraction
}

export type AutoReason = 'undercut' | 'own-low' | 'ceiling' | 'floor' | 'no-market' | 'no-price'

const toCents = (isk: number) => Math.round(isk * 100)
const fromCents = (cents: number) => cents / 100

// EVE orders accept 4 significant figures, and never finer than 0.01 ISK.
function tickCents(cents: number): number {
  return Math.max(1, 10 ** (String(cents).length - 4))
}

function ceilTick(isk: number): number {
  const c = Math.ceil(toCents(isk) - 1e-6)
  const t = tickCents(c)
  return fromCents(Math.ceil(c / t) * t)
}

function floorTick(isk: number): number {
  const c = Math.floor(toCents(isk) + 1e-6)
  const t = tickCents(c)
  return fromCents(Math.floor(c / t) * t)
}

/** Closest price EVE will accept. */
export function nearestTick(isk: number): number {
  const c = Math.max(1, toCents(isk))
  const t = tickCents(c)
  return fromCents(Math.max(t, Math.round(c / t) * t))
}

/** The highest valid price strictly below `isk`. */
export function undercut(isk: number): number {
  const c = toCents(isk)
  if (c <= 1) return fromCents(c)
  const t = tickCents(c - 1)
  return fromCents(Math.floor((c - 1) / t) * t)
}

/** The price that earns `pct`% on cost once fees are paid. Rounded up, so it never earns less. */
export function priceForProfit(cost: number, pct: number, feeFrac: number): number {
  return ceilTick(cost * (1 + pct / 100) / (1 - feeFrac))
}

/** Default price: just under the market, held inside the profit range. */
export function autoPrice(item: PricingInput, range: PriceRange): { price: number | null; reason: AutoReason } {
  const { cost, low, ownPrices, feeFrac } = item
  const ownLow = low != null && ownPrices.some(p => toCents(p) === toCents(low))
  const market = low == null ? null : ownLow ? low : undercut(low)

  if (cost <= 0) {
    if (market == null) return { price: null, reason: 'no-price' }
    return { price: market, reason: ownLow ? 'own-low' : 'undercut' }
  }

  const minPct = Math.min(range.minPct, range.maxPct)
  const maxPct = Math.max(range.minPct, range.maxPct)
  const floor = priceForProfit(cost, minPct, feeFrac)
  const ceiling = Math.max(floor, floorTick(cost * (1 + maxPct / 100) / (1 - feeFrac)))

  if (market == null) return { price: ceiling, reason: 'no-market' }
  if (market < floor) return { price: floor, reason: 'floor' }
  if (market > ceiling) return { price: ceiling, reason: 'ceiling' }
  return { price: market, reason: ownLow ? 'own-low' : 'undercut' }
}

export function profitPerUnit(price: number, cost: number, feeFrac: number): number {
  return price * (1 - feeFrac) - cost
}

export type Notation = 'point' | 'comma'

/** Text for the Import Prices button in EVE's sell window. The only place that knows the layout. */
export function importText(rows: { name: string; price: number }[], notation: Notation): string {
  return rows
    .map(r => {
      const value = r.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      return `${r.name} ${notation === 'comma' ? value.replace(/[.,]/g, c => (c === '.' ? ',' : '.')) : value}`
    })
    .join('\n')
}
