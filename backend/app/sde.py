import sqlite3
from functools import lru_cache
from .config import settings


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
    row = get_sde().execute(
        """SELECT COALESCE(v.volume, t.volume) AS volume
           FROM invTypes t LEFT JOIN invVolumes v ON t.typeID = v.typeID
           WHERE t.typeID = ?""",
        (type_id,),
    ).fetchone()
    return float(row["volume"]) if row else None


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
        f"""SELECT t.typeID, COALESCE(v.volume, t.volume) AS volume
            FROM invTypes t LEFT JOIN invVolumes v ON t.typeID = v.typeID
            WHERE t.typeID IN ({placeholders})""",
        type_ids,
    ).fetchall()
    return {row["typeID"]: float(row["volume"]) for row in rows}


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
    """Returns regionID for an NPC station from the SDE, or None for player structures."""
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
