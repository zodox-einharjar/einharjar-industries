import sqlite3
from functools import lru_cache
from .config import settings

# Official CCP SDE omits packaged volumes for ships; the assembled volume in
# invTypes is far too large to use for freight cost calculations.
# These are the in-game packaged volumes keyed by ship groupID.
_SHIP_GROUP_PACKAGED: dict[int, float] = {
    29: 500,          # Capsule
    31: 500,          # Shuttle
    237: 2_500,       # Corvette
    25: 2_500,        # Frigate
    324: 2_500,       # Assault Frigate
    830: 2_500,       # Covert Ops
    831: 2_500,       # Interceptor
    834: 2_500,       # Stealth Bomber
    893: 2_500,       # Electronic Attack Ship
    1283: 2_500,      # Expedition Frigate
    1527: 2_500,      # Logistics Frigate
    1022: 2_500,      # Prototype Exploration Ship
    420: 5_000,       # Destroyer
    1534: 5_000,      # Command Destroyer
    541: 5_000,       # Interdictor
    1305: 5_000,      # Tactical Destroyer
    26: 10_000,       # Cruiser
    906: 10_000,      # Combat Recon Ship
    833: 10_000,      # Force Recon Ship
    358: 10_000,      # Heavy Assault Cruiser
    894: 10_000,      # Heavy Interdiction Cruiser
    832: 10_000,      # Logistics
    963: 10_000,      # Strategic Cruiser
    1972: 10_000,     # Flag Cruiser
    419: 15_000,      # Combat Battlecruiser
    1201: 15_000,     # Attack Battlecruiser
    540: 15_000,      # Command Ship
    27: 50_000,       # Battleship
    898: 50_000,      # Black Ops
    900: 50_000,      # Marauder
    28: 20_000,       # Hauler (T1 Industrial)
    1202: 20_000,     # Blockade Runner
    380: 20_000,      # Deep Space Transport
    463: 3_750,       # Mining Barge
    543: 3_750,       # Exhumer
    941: 500_000,     # Industrial Command Ship (Orca default)
    513: 1_000_000,   # Freighter
    902: 1_000_000,   # Jump Freighter
    547: 1_000_000,   # Carrier
    485: 1_000_000,   # Dreadnought
    4594: 1_000_000,  # Lancer Dreadnought
    1538: 1_000_000,  # Force Auxiliary
    883: 1_000_000,   # Capital Industrial Ship (Rorqual)
    659: 1_000_000,   # Supercarrier
    30: 10_000_000,   # Titan
}

# Per-type overrides for ships whose packaged volume differs from the group default.
_SHIP_TYPE_PACKAGED: dict[int, float] = {
    42244: 50_000,  # Porpoise — groupID 941 (same as Orca) but packages to 50k m³
}


@lru_cache(maxsize=1)
def get_sde() -> sqlite3.Connection:
    conn = sqlite3.connect(settings.sde_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def type_name(type_id: int) -> str | None:
    row = get_sde().execute(
        "SELECT typeName FROM invTypes WHERE typeID = ?", (type_id,)
    ).fetchone()
    return row["typeName"] if row else None


def type_volume(type_id: int) -> float | None:
    vols = type_volumes([type_id])
    return vols.get(type_id)


def type_names(type_ids: list[int]) -> dict[int, str]:
    if not type_ids:
        return {}
    placeholders = ",".join("?" * len(type_ids))
    rows = get_sde().execute(
        f"SELECT typeID, typeName FROM invTypes WHERE typeID IN ({placeholders})", type_ids
    ).fetchall()
    return {row["typeID"]: row["typeName"] for row in rows}


def type_volumes(type_ids: list[int]) -> dict[int, float]:
    if not type_ids:
        return {}
    placeholders = ",".join("?" * len(type_ids))
    rows = get_sde().execute(
        f"""SELECT t.typeID, t.volume, t.groupID, g.categoryID
            FROM invTypes t
            JOIN invGroups g ON t.groupID = g.groupID
            WHERE t.typeID IN ({placeholders})""",
        type_ids,
    ).fetchall()
    result = {}
    for row in rows:
        tid = row["typeID"]
        if row["categoryID"] == 6:  # Ship — use packaged volume for freight
            vol = (
                _SHIP_TYPE_PACKAGED.get(tid)
                or _SHIP_GROUP_PACKAGED.get(row["groupID"])
                or float(row["volume"] or 0)
            )
        else:
            vol = float(row["volume"] or 0)
        result[tid] = vol
    return result


def station_name(station_id: int) -> str | None:
    row = get_sde().execute(
        "SELECT stationName FROM staStations WHERE stationID = ?", (station_id,)
    ).fetchone()
    return row["stationName"] if row else None


def type_id_by_name(name: str) -> int | None:
    row = get_sde().execute(
        "SELECT typeID FROM invTypes WHERE typeName = ?", (name,)
    ).fetchone()
    return row["typeID"] if row else None


def station_by_name(name: str) -> tuple[int, int] | None:
    """Returns (stationID, regionID) or None if not an NPC station."""
    row = get_sde().execute(
        "SELECT stationID, regionID FROM staStations WHERE stationName = ?", (name,)
    ).fetchone()
    return (row["stationID"], row["regionID"]) if row else None


def type_categories(type_ids: list[int]) -> dict[int, str]:
    """Returns {type_id: 'hull'|'module'|'ammo'|'other'} for each type_id."""
    if not type_ids:
        return {}
    placeholders = ",".join("?" * len(type_ids))
    rows = get_sde().execute(
        f"""SELECT t.typeID, g.categoryID
            FROM invTypes t JOIN invGroups g ON t.groupID = g.groupID
            WHERE t.typeID IN ({placeholders})""",
        type_ids,
    ).fetchall()
    mapping = {6: "hull", 7: "module", 8: "ammo"}
    return {row["typeID"]: mapping.get(row["categoryID"], "other") for row in rows}


def search_types(query: str, limit: int = 20) -> list[dict]:
    """Fuzzy name search returning [{type_id, name}]."""
    rows = get_sde().execute(
        "SELECT typeID, typeName FROM invTypes WHERE typeName LIKE ? AND published = 1 LIMIT ?",
        (f"%{query}%", limit),
    ).fetchall()
    return [{"type_id": row["typeID"], "name": row["typeName"]} for row in rows]


def region_id_for_station(station_eve_id: int) -> int | None:
    """Returns regionID for an NPC station, or None for player structures."""
    row = get_sde().execute(
        "SELECT regionID FROM staStations WHERE stationID = ?", (station_eve_id,)
    ).fetchone()
    return row["regionID"] if row else None


def region_id_for_system(solar_system_id: int) -> int | None:
    """Returns regionID for a solar system ID."""
    row = get_sde().execute(
        "SELECT regionID FROM mapSolarSystems WHERE solarSystemID = ?", (solar_system_id,)
    ).fetchone()
    return row["regionID"] if row else None


def system_name_for_station(station_eve_id: int) -> str | None:
    row = get_sde().execute(
        """SELECT ms.solarSystemName
           FROM staStations s
           JOIN mapSolarSystems ms ON s.solarSystemID = ms.solarSystemID
           WHERE s.stationID = ?""",
        (station_eve_id,),
    ).fetchone()
    return row["solarSystemName"] if row else None
