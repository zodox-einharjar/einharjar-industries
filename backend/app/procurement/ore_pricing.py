from sqlalchemy import func, select

from ..models import MarketOrder
from ..sde import gas_type_ids, ore_type_ids, portion_sizes, reprocessing_materials


async def _jita_reference_prices(
    session, jita_loc_id: int, type_ids: list[int], price_type: str,
) -> dict[int, float]:
    """Jita buy/sell/split reference price per type_id, from cached MarketOrder rows —
    the same buy/sell/split convention the pasted buyback list's own price_type uses,
    just sourced from our own market data instead of a pasted column."""
    if not type_ids:
        return {}
    sell: dict[int, float] = {}
    buy: dict[int, float] = {}
    if price_type in ("sell", "split"):
        rows = (await session.execute(
            select(MarketOrder.type_id, func.min(MarketOrder.price).label("price"))
            .where(MarketOrder.location_id == jita_loc_id)
            .where(MarketOrder.type_id.in_(type_ids))
            .where(MarketOrder.is_buy.is_(False))
            .group_by(MarketOrder.type_id)
        )).all()
        sell = {r.type_id: float(r.price) for r in rows}
    if price_type in ("buy", "split"):
        rows = (await session.execute(
            select(MarketOrder.type_id, func.max(MarketOrder.price).label("price"))
            .where(MarketOrder.location_id == jita_loc_id)
            .where(MarketOrder.type_id.in_(type_ids))
            .where(MarketOrder.is_buy.is_(True))
            .group_by(MarketOrder.type_id)
        )).all()
        buy = {r.type_id: float(r.price) for r in rows}

    if price_type == "sell":
        return sell
    if price_type == "buy":
        return buy
    out: dict[int, float] = {}
    for tid in set(buy) | set(sell):
        vals = [v for v in (buy.get(tid), sell.get(tid)) if v is not None]
        if vals:
            out[tid] = sum(vals) / len(vals)
    return out


async def reprice_ore_by_reprocessed_value(
    session, jita_loc_id: int | None, resolved: list[dict], price_type: str,
    efficiency: float, gas_efficiency: float, fee_pct: float = 0.0,
) -> set[int]:
    """Mutates `resolved` items in place: for any pasted line that's raw or compressed
    ore/ice/gas, overrides unit_price with the reprocessed mineral value (at the given
    efficiency — gas uses gas_efficiency instead, since gas can't be reprocessed at all
    in EVE and is decompressed under its own Gas Decompression Efficiency skill,
    independent of ore/ice's — priced off Jita per price_type) instead of the item's own
    market price — matching how a buyback program typically prices ore, since its
    trading price often has little to do with what the corp actually realizes by
    reprocessing it.

    fee_pct is the station's reprocessing tax/fee, as a percentage of the raw output
    value — it reduces what the corp actually nets from reprocessing the ore, so it's
    subtracted before pricing: net_value = raw_value * (1 - fee_pct / 100).

    Returns the set of type_ids that were repriced this way.
    """
    if not jita_loc_id:
        return set()
    candidate_ids = ore_type_ids([i["type_id"] for i in resolved])
    if not candidate_ids:
        return set()

    portions = portion_sizes(list(candidate_ids))
    yields = reprocessing_materials(list(candidate_ids))
    mineral_ids = list({m["material_type_id"] for lst in yields.values() for m in lst})
    mineral_prices = await _jita_reference_prices(session, jita_loc_id, mineral_ids, price_type)
    gas_ids = gas_type_ids(list(candidate_ids))

    repriced: set[int] = set()
    for item in resolved:
        tid = item["type_id"]
        if tid not in candidate_ids:
            continue
        portion = portions.get(tid)
        mats = yields.get(tid)
        if not portion or not mats:
            continue
        item_efficiency = gas_efficiency if tid in gas_ids else efficiency
        value_per_portion = sum(
            m["quantity"] * item_efficiency * mineral_prices.get(m["material_type_id"], 0.0)
            for m in mats
        )
        net_value_per_portion = value_per_portion * (1 - fee_pct / 100.0)
        item["unit_price"] = net_value_per_portion / portion
        repriced.add(tid)

    return repriced
