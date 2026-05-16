from fastapi.templating import Jinja2Templates

templates = Jinja2Templates(directory="templates")


def _fmt_isk(value, decimals=0):
    if value is None:
        return "—"
    return f"{float(value):,.{decimals}f}"


def _fmt_iska(value):
    """Abbreviated ISK: 1.24b, 980.5m, 50k"""
    if value is None:
        return "—"
    v = float(value)
    if abs(v) >= 1_000_000_000:
        return f"{v / 1_000_000_000:.2f}B"
    if abs(v) >= 1_000_000:
        return f"{v / 1_000_000:.1f}M"
    if abs(v) >= 1_000:
        return f"{v / 1_000:.0f}K"
    return f"{v:.0f}"


templates.env.filters["isk"] = _fmt_isk
templates.env.filters["iska"] = _fmt_iska
