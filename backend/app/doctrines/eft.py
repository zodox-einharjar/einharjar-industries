import re
from collections import defaultdict

from ..sde import get_sde


class EFTParseError(ValueError):
    pass


def parse_eft(raw: str) -> dict:
    """
    Parse an EFT-format fit string into ship + items.

    Returns:
        {
            "ship_type_id": int,
            "fit_name": str,
            "items": {type_id: quantity, ...}  # aggregated, includes hull
        }

    EFT rules applied:
    - "Module, Charge" line  → module qty+1, charge qty+1 (loaded round)
    - "Item xN" line         → item qty+N (drones, cargo)
    - Plain "Module" line    → qty+1
    - "[Empty *]" lines      → skipped
    - Loaded charges + cargo charges for the same type_id are summed
    """
    lines = raw.strip().splitlines()
    if not lines:
        raise EFTParseError("Empty EFT text")

    header = lines[0].strip()
    if not header.startswith("[") or "]" not in header:
        raise EFTParseError(f"Invalid EFT header: {header!r}")

    inner = header[1 : header.index("]")]
    if "," not in inner:
        raise EFTParseError(f"EFT header missing fit name: {header!r}")

    ship_name, fit_name = inner.split(",", 1)
    ship_name = ship_name.strip()
    fit_name = fit_name.strip()

    sde = get_sde()

    ship_row = sde.execute(
        "SELECT typeID FROM invTypes WHERE typeName = ?", (ship_name,)
    ).fetchone()
    if not ship_row:
        raise EFTParseError(f"Unknown ship: {ship_name!r}")

    ship_type_id: int = ship_row["typeID"]
    quantities: dict[int, int] = defaultdict(int)
    quantities[ship_type_id] += 1
    skipped: list[str] = []

    def resolve(name: str) -> int | None:
        row = sde.execute(
            "SELECT typeID FROM invTypes WHERE typeName = ?", (name,)
        ).fetchone()
        if not row:
            skipped.append(name)
            return None
        return row["typeID"]

    for line in lines[1:]:
        line = line.strip()
        if not line or line.startswith("["):
            continue

        # "Item xN" — drones, cargo charges, implants, etc.
        m = re.match(r"^(.+?)\s+x(\d+)$", line, re.IGNORECASE)
        if m:
            tid = resolve(m.group(1).strip())
            if tid:
                quantities[tid] += int(m.group(2))
            continue

        # "Module, Charge" — slot with loaded ammo
        if "," in line:
            module_name, charge_name = line.split(",", 1)
            mid = resolve(module_name.strip())
            cid = resolve(charge_name.strip())
            if mid:
                quantities[mid] += 1
            if cid:
                quantities[cid] += 1
            continue

        # Plain module
        tid = resolve(line)
        if tid:
            quantities[tid] += 1

    return {
        "ship_type_id": ship_type_id,
        "fit_name": fit_name,
        "items": dict(quantities),
        "skipped": skipped,
    }
