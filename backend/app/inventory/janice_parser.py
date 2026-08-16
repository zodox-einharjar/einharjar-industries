import re

from ..sde import type_id_by_name, type_names


def parse_janice_text(text: str, price_type: str) -> tuple[list[dict], list[str]]:
    """Parse Janice's "select all rows and copy" output: tab-separated
    name/qty/volume/buy/sell (falls back to 2+-space splitting).

    price_type: "buy" | "sell" | "split".
    Returns ([{type_id, item_name, qty, unit_price, ok}], [error strings]).
    """
    items = []
    errors = []

    for lineno, raw in enumerate(text.strip().splitlines(), 1):
        parts = raw.split('\t')
        if len(parts) < 5:
            parts = re.split(r' {2,}', raw.strip())
        if len(parts) < 5:
            errors.append(f"Line {lineno}: expected 5 columns (name, qty, vol, buy, sell)")
            continue

        name = parts[0].strip()
        try:
            qty = int(parts[1].replace(',', '').strip())
        except ValueError:
            errors.append(f"Line {lineno}: invalid quantity '{parts[1].strip()}'")
            continue
        try:
            buy_p  = float(parts[3].replace(',', '').strip())
            sell_p = float(parts[4].replace(',', '').strip())
        except ValueError:
            errors.append(f"Line {lineno}: invalid price")
            continue

        if price_type == "buy":
            unit_price = buy_p
        elif price_type == "sell":
            unit_price = sell_p
        else:
            unit_price = (buy_p + sell_p) / 2

        tid = type_id_by_name(name)
        canonical = type_names([tid]).get(tid) if tid else None
        items.append({
            "type_id": tid,
            "item_name": canonical or name,
            "qty": qty,
            "unit_price": unit_price,
            "ok": tid is not None,
        })

    return items, errors
