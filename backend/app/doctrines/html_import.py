from dataclasses import dataclass, field

from bs4 import BeautifulSoup

from .eft import EFTParseError, parse_eft


class HTMLImportError(ValueError):
    pass


@dataclass
class ParsedFit:
    source_fit_name: str
    ship_name: str | None
    raw_eft: str | None
    fit_name: str | None = None
    ship_type_id: int | None = None
    items: dict[int, int] = field(default_factory=dict)
    skipped: list[str] = field(default_factory=list)
    target_qty: int = 0
    target_warning: str | None = None
    parse_error: str | None = None


@dataclass
class ParsedDoctrine:
    name: str
    fits: list[ParsedFit] = field(default_factory=list)


def _extract_target_qty(fit_row) -> tuple[int, str | None]:
    label = fit_row.find(
        lambda tag: tag.name == "div" and tag.get_text(strip=True) == "Target"
    )
    value_tag = label.find_previous_sibling("div") if label else None
    if value_tag is None:
        return 0, "No target quantity found — defaulted to 0"
    text = value_tag.get_text(strip=True)
    try:
        return int(text), None
    except ValueError:
        return 0, f"Unparseable target quantity {text!r} — defaulted to 0"


def parse_neocom_html(html: str) -> list[ParsedDoctrine]:
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select("div.doctrine-card")
    if not cards:
        raise HTMLImportError(
            "No doctrine cards found in the pasted HTML — make sure you copied the "
            "outerHTML of the correct container element from the alliance doctrine tool."
        )

    doctrines: list[ParsedDoctrine] = []
    for card in cards:
        header = card.select_one("h2")
        name = header.get_text(strip=True) if header else "(unnamed doctrine)"
        doctrine = ParsedDoctrine(name=name)

        for row in card.select("div.fit-row"):
            source_fit_name = row.get("data-fit-name") or ""
            ship_name = row.get("data-ship-name")
            button = row.select_one("button.copy-eft")
            raw_eft = button.get("data-eft") if button else None

            fit = ParsedFit(source_fit_name=source_fit_name, ship_name=ship_name, raw_eft=raw_eft)
            fit.target_qty, fit.target_warning = _extract_target_qty(row)

            if not raw_eft or not raw_eft.strip():
                fit.parse_error = "No EFT text found for this fit"
            else:
                try:
                    parsed = parse_eft(raw_eft)
                except EFTParseError as e:
                    fit.parse_error = str(e)
                else:
                    fit.fit_name = parsed["fit_name"]
                    fit.ship_type_id = parsed["ship_type_id"]
                    fit.items = parsed["items"]
                    fit.skipped = parsed.get("skipped", [])

            doctrine.fits.append(fit)

        doctrines.append(doctrine)

    return doctrines
