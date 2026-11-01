import asyncio

from sqlalchemy import func, select

from ..doctrines.shortfall import aggregate_shortfalls
from ..inventory.free_stock import free_qty_by_location
from ..market.velocity import daily_velocity
from ..models import FreightRoute, Location, MarketOrder
from ..sde import resolve_region_id, type_volumes

JITA_EVE_ID = 60003760
_VELOCITY_CONCURRENCY = 8


def _freight(route: FreightRoute | None, vol: float, price: float) -> float:
    if route is None:
        return 0.0
    return vol * float(route.isk_per_m3) + price * float(route.value_pct)


def _ladder(pools: list[tuple[str, list[list[float]], FreightRoute | None]], vol: float, want: int) -> list[dict]:
    """Merge every source's remaining price levels into one list sorted by landed cost.

    Each pool is (source, [[unit_price, qty_remaining], ...], route). Levels are cut off
    once comfortably past `want` so the client can re-price edited quantities without
    the response carrying entire order books.
    """
    levels = []
    for source, book, route in pools:
        for price, qty in book:
            if qty > 0:
                levels.append({
                    "source": source, "unit_price": price, "qty": int(qty),
                    "landed": price + _freight(route, vol, price),
                })
    levels.sort(key=lambda l: l["landed"])
    out, cum, limit = [], 0, max(want * 2, want + 10)
    for l in levels:
        out.append(l)
        cum += l["qty"]
        if cum >= limit:
            break
    return out


def _consume(pools: dict[str, list[list[float]]], ladder: list[dict], qty: int) -> None:
    """Remove `qty` units, cheapest-landed first, from the shared pools the ladder came from."""
    for l in ladder:
        if qty <= 0:
            break
        take = min(qty, l["qty"])
        for level in pools[l["source"]]:
            if level[0] == l["unit_price"] and level[1] > 0:
                t = min(take, level[1])
                level[1] -= t
                take -= t
                qty -= t
                if take <= 0:
                    break


async def build_plan(
    session, *, mode: str, doctrine_fit_ids: set[int] | None, fill_pct: float,
    net_inventory: bool, window_days: int, buyback_items: list[dict], buyback_location_id: int | None,
) -> dict:
    items_acc = await aggregate_shortfalls(session, doctrine_fit_ids, fill_pct)

    all_locs = (await session.execute(select(Location))).scalars().all()
    loc_by_id = {l.id: l for l in all_locs}
    jita = next((l for l in all_locs if l.eve_id == JITA_EVE_ID), None)
    jita_id = jita.id if jita else None

    staging_ids = {sid for sid, _ in items_acc}
    type_ids = {tid for _, tid in items_acc}

    # Shared order books: each level is a mutable [price, qty_remaining] so one staging
    # location's purchases are gone before the next one is planned.
    def _books(entries) -> dict[int, list[list[float]]]:
        merged: dict[int, dict[float, int]] = {}
        for tid, price, qty in entries:
            by_price = merged.setdefault(tid, {})
            by_price[price] = by_price.get(price, 0) + qty
        return {tid: sorted([[p, q] for p, q in bp.items()]) for tid, bp in merged.items()}

    jita_orders = []
    if jita_id and type_ids:
        jita_orders = (await session.execute(
            select(MarketOrder).where(
                MarketOrder.location_id == jita_id,
                MarketOrder.type_id.in_(list(type_ids)),
                MarketOrder.is_buy.is_(False),
            )
        )).scalars().all()
    jita_books = _books((o.type_id, float(o.price), o.volume_remain) for o in jita_orders)
    buyback_books = _books((i["type_id"], float(i["unit_price"]), i["qty"]) for i in buyback_items)

    from_ids = {i for i in (jita_id, buyback_location_id) if i}
    routes: dict[tuple[int, int], FreightRoute] = {}
    if from_ids and staging_ids:
        for r in (await session.execute(
            select(FreightRoute).where(FreightRoute.from_id.in_(from_ids), FreightRoute.to_id.in_(staging_ids))
        )).scalars().all():
            routes[(r.from_id, r.to_id)] = r

    free = await free_qty_by_location(session, type_ids) if net_inventory else {}
    vols = type_volumes(list(type_ids))

    velocity: dict[tuple[int, int], float] = {}
    if mode == "profit":
        cache: dict[tuple[int, int], list[dict]] = {}
        sem = asyncio.Semaphore(_VELOCITY_CONCURRENCY)
        region_by_loc = {sid: resolve_region_id(loc_by_id[sid].eve_id, loc_by_id[sid].region_id) for sid in staging_ids}

        async def _vel(key):
            region = region_by_loc.get(key[0])
            if not region:
                return key, 0.0
            async with sem:
                return key, await daily_velocity(region, key[1], cache)

        velocity = dict(await asyncio.gather(*(_vel(k) for k in items_acc)))

    groups: dict[int, dict] = {}
    for sid in staging_ids:
        loc = loc_by_id[sid]
        jita_route_missing = sid != jita_id and (jita_id, sid) not in routes
        bb_route_missing = bool(
            buyback_items and buyback_location_id and buyback_location_id != sid
            and (buyback_location_id, sid) not in routes
        )
        groups[sid] = {
            "location_id": sid, "location_name": loc.name,
            "fee_pct": loc.broker_fee_pct + loc.sales_tax_pct + loc.scc_surcharge_pct,
            "freight_missing": jita_route_missing,
            "buyback_freight_missing": bb_route_missing,
            "items": [], "secondary": [],
        }

    # Biggest shortfalls get first pick of the shared Jita/buyback depth.
    ordered = sorted(items_acc.items(), key=lambda kv: kv[1]["qty_shortfall"], reverse=True)
    for (sid, tid), acc in ordered:
        group = groups[sid]
        owned = free.get((sid, tid), 0)
        qty_wanted = max(0, acc["qty_shortfall"] - owned)
        if qty_wanted <= 0:
            continue

        vol = float(vols.get(tid, 0))
        jita_route = None if sid == jita_id else routes.get((jita_id, sid))
        bb_route = None if buyback_location_id in (None, sid) else routes.get((buyback_location_id, sid))
        pools = {"jita": jita_books.get(tid, []), "buyback": buyback_books.get(tid, [])}
        ladder = _ladder([("buyback", pools["buyback"], bb_route), ("jita", pools["jita"], jita_route)], vol, qty_wanted)
        depth = sum(l["qty"] for l in ladder)

        staging_price = float(acc["staging_price"]) if acc["staging_price"] is not None else None
        net_proceeds = staging_price * (1 - group["fee_pct"] / 100.0) if staging_price is not None else None
        v_daily = velocity.get((sid, tid))

        reason = None
        if mode == "fill":
            qty_to_buy = min(qty_wanted, depth)
            if depth == 0:
                reason = "no_supply"
        else:
            cap = min(qty_wanted, round((v_daily or 0) * window_days))
            qty_to_buy = 0
            if net_proceeds is not None:
                for l in ladder:
                    if qty_to_buy >= cap or l["landed"] >= net_proceeds:
                        break
                    qty_to_buy += min(l["qty"], cap - qty_to_buy)
            if not v_daily:
                reason = "no_sales"
            elif depth == 0:
                reason = "no_supply"
            elif net_proceeds is None:
                reason = "no_local_price"
            elif qty_to_buy == 0:
                reason = "unprofitable"

        _consume(pools, ladder, qty_to_buy)

        row = {
            "type_id": tid, "name": acc["name"],
            "qty_needed": acc["qty_needed"], "qty_local": acc["qty_available"],
            "qty_owned": owned, "qty_wanted": qty_wanted, "qty_to_buy": qty_to_buy,
            "depth": depth, "unit_m3": vol,
            "staging_price": staging_price, "net_proceeds": net_proceeds,
            "velocity_daily": round(v_daily, 2) if v_daily is not None else None,
            "ladder": ladder, "reason": reason,
            "doctrines": [{"doctrine_name": dn, "fit_name": fn} for dn, fn in sorted(acc["doctrines"])],
        }
        (group["secondary"] if qty_to_buy == 0 else group["items"]).append(row)

    used_types = {r["type_id"] for g in groups.values() for r in g["items"] + g["secondary"]}
    buyback_unused = sorted(
        {i["item_name"] for i in buyback_items if i["type_id"] not in used_types}
    )

    last_poll = (await session.execute(select(func.max(MarketOrder.fetched_at)))).scalar_one_or_none()
    out_groups = [g for g in groups.values() if g["items"] or g["secondary"]]
    out_groups.sort(key=lambda g: g["location_name"])
    for g in out_groups:
        g["items"].sort(key=lambda r: r["name"])
        g["secondary"].sort(key=lambda r: r["name"])

    return {
        "generated_at": last_poll.isoformat() if last_poll else None,
        "mode": mode,
        "groups": out_groups,
        "buyback_unused": buyback_unused,
    }
