from ..sde import type_id_by_name


def parse_name_qty_text(text: str) -> tuple[list[dict], list[str]]:
    """Parse 'Name<tab-or-space>Qty' lines with no price column. Returns
    ([{type_id, name, qty}], [unresolved lines])."""
    resolved = []
    unresolved = []
    for raw in text.strip().splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split('\t')
        if len(parts) < 2:
            parts = line.rsplit(None, 1)
        if len(parts) < 2:
            unresolved.append(line)
            continue
        name = parts[0].strip()
        try:
            qty = int(parts[1].replace(',', '').strip())
        except ValueError:
            unresolved.append(line)
            continue
        tid = type_id_by_name(name)
        if tid is None:
            unresolved.append(name)
            continue
        resolved.append({"type_id": tid, "name": name, "qty": qty})
    return resolved, unresolved
