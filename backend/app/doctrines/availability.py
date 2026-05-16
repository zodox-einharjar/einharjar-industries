from collections import defaultdict
from decimal import Decimal
from typing import Any

from ..models import DoctrineFit, MarketOrder
from ..sde import type_names, type_volumes


def _status(pct: float) -> tuple[str, str]:
    """Returns (status_key, bootstrap_bg_class)."""
    if pct >= 1.0:
        return "green", "success"
    elif pct >= 0.5:
        return "yellow", "warning"
    elif pct > 0:
        return "orange", "orange"
    return "red", "danger"


def calculate(
    doctrine_fit: DoctrineFit,
    staging_orders: dict[int, list[MarketOrder]],
    jita_orders: dict[int, list[MarketOrder]],
    freight_isk_per_m3: Decimal | None,
    freight_value_pct: Decimal | None,
    broker_fee_pct: float = 0.0,
    sales_tax_pct: float = 0.0,
) -> dict[str, Any]:
    """
    Calculate availability for one doctrine fit.

    staging_orders / jita_orders: {type_id: [MarketOrder, ...] sorted by price asc}
    freight_value_pct is a decimal fraction (e.g. 0.01 = 1%).
    """
    fit = doctrine_fit.fit
    target_qty = doctrine_fit.target_qty

    all_type_ids = [item.type_id for item in fit.items]
    names = type_names([fit.ship_type_id] + all_type_ids)
    volumes = type_volumes(all_type_ids)

    item_rows: list[dict] = []
    min_completable: int | None = None

    for item in fit.items:
        qty_needed = item.quantity * target_qty
        s_orders = staging_orders.get(item.type_id, [])
        j_orders = jita_orders.get(item.type_id, [])

        qty_available = sum(o.volume_remain for o in s_orders)
        fits_possible = qty_available // item.quantity if item.quantity else 0

        staging_price: Decimal | None = s_orders[0].price if s_orders else None
        jita_price: Decimal | None = j_orders[0].price if j_orders else None

        freight_per_unit: Decimal | None = None
        if jita_price is not None and freight_isk_per_m3 is not None and freight_value_pct is not None:
            vol = Decimal(str(volumes.get(item.type_id, 0)))
            freight_per_unit = vol * freight_isk_per_m3 + jita_price * freight_value_pct

        import_cost: Decimal | None = None
        if jita_price is not None:
            import_cost = jita_price + (freight_per_unit or Decimal(0))

        profit_to_import: Decimal | None = None
        if staging_price is not None and import_cost is not None:
            total_fee = Decimal(str(broker_fee_pct + sales_tax_pct)) / Decimal("100")
            profit_to_import = staging_price - import_cost - staging_price * total_fee

        item_rows.append({
            "type_id": item.type_id,
            "name": names.get(item.type_id, f"[{item.type_id}]"),
            "qty_per_fit": item.quantity,
            "qty_needed": qty_needed,
            "qty_available": qty_available,
            "staging_price": staging_price,
            "jita_price": jita_price,
            "freight_per_unit": freight_per_unit,
            "import_cost": import_cost,
            "profit_to_import": profit_to_import,
        })

        min_completable = fits_possible if min_completable is None else min(min_completable, fits_possible)

    completable = min_completable if min_completable is not None else 0
    pct = min(completable / target_qty, 1.0) if target_qty > 0 else 0.0
    status_key, status_class = _status(pct)

    return {
        "df_id": doctrine_fit.id,
        "fit": fit,
        "ship_name": names.get(fit.ship_type_id, f"[{fit.ship_type_id}]"),
        "target_qty": target_qty,
        "completable": completable,
        "pct": pct,
        "pct_str": f"{pct:.0%}",
        "status": status_key,
        "status_class": status_class,
        "item_rows": item_rows,
        "staging_total": (
            sum(Decimal(str(r["qty_per_fit"])) * r["staging_price"] for r in item_rows)
            if all(r["staging_price"] is not None for r in item_rows) else None
        ),
        "jita_total": sum(
            Decimal(str(r["qty_per_fit"])) * r["jita_price"]
            for r in item_rows if r["jita_price"]
        ) or None,
        "import_total": sum(
            Decimal(str(r["qty_per_fit"])) * r["import_cost"]
            for r in item_rows if r["import_cost"]
        ) or None,
    }
