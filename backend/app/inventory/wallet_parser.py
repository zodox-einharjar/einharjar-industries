from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation


@dataclass
class WalletRow:
    purchased_at: datetime
    qty: int
    item_name: str
    unit_price: Decimal
    total_price: Decimal
    counterparty: str
    station_name: str
    character_name: str
    wallet_name: str
    is_buy: bool


def _parse_isk(s: str) -> Decimal:
    return Decimal(s.strip().replace(",", "").replace(" ISK", "").replace("ISK", ""))


def parse_wallet_text(text: str) -> tuple[list[WalletRow], list[str]]:
    rows: list[WalletRow] = []
    errors: list[str] = []

    for i, line in enumerate(text.strip().splitlines(), 1):
        line = line.strip()
        if not line:
            continue

        parts = [p.strip() for p in line.split("\t")]
        if len(parts) < 7:
            errors.append(f"Line {i}: expected at least 7 tab-separated fields, got {len(parts)}")
            continue

        try:
            purchased_at = datetime.strptime(parts[0], "%Y.%m.%d %H:%M")
        except ValueError:
            errors.append(f"Line {i}: invalid date '{parts[0]}'")
            continue

        try:
            qty = int(parts[1].replace(",", ""))
            unit_price = _parse_isk(parts[3])
            total_price = _parse_isk(parts[4])
        except (ValueError, InvalidOperation):
            errors.append(f"Line {i}: could not parse quantity or price")
            continue

        rows.append(WalletRow(
            purchased_at=purchased_at,
            qty=qty,
            item_name=parts[2],
            unit_price=unit_price,
            total_price=total_price,
            counterparty=parts[5],
            station_name=parts[6],
            character_name=parts[7] if len(parts) > 7 else "",
            wallet_name=parts[8] if len(parts) > 8 else "",
            is_buy=total_price < 0,
        ))

    return rows, errors
