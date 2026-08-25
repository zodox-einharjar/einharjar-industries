from decimal import Decimal

from ..models import MarketOrder


def walk_sell_book(orders: list[MarketOrder], qty: int) -> dict:
    """Walk sell orders cheapest-first up to qty; returns the true volume-weighted cost
    rather than assuming every unit costs what the single best order costs."""
    ordered = sorted(orders, key=lambda o: float(o.price))
    remaining = qty
    total_cost = Decimal(0)
    filled = 0
    worst_price: Decimal | None = None
    for o in ordered:
        if remaining <= 0:
            break
        take = min(remaining, o.volume_remain)
        total_cost += o.price * take
        filled += take
        worst_price = o.price
        remaining -= take
    return {
        "unit_cost_avg": float(total_cost / filled) if filled else None,
        "qty_fillable": filled,
        "worst_unit_price": float(worst_price) if worst_price is not None else None,
    }
