#!/usr/bin/env python3
"""
Download and convert the official CCP EVE SDE to SQLite.

Run from backend/:
    python -m scripts.update_sde

or from the project root:
    python backend/scripts/update_sde.py

Checks the CCP build number and skips the download if unchanged.
Writes to the path set by SDE_PATH env var (default: data/sqlite-latest.sqlite).
"""

import io
import json
import os
import sqlite3
import zipfile
from pathlib import Path

import httpx
import yaml

try:
    _YAML_LOADER = yaml.CSafeLoader  # libyaml-backed — ~7x faster than SafeLoader
except AttributeError:
    _YAML_LOADER = yaml.SafeLoader

LATEST_URL = "https://developers.eveonline.com/static-data/tranquility/latest.jsonl"
ZIP_PATTERN = "https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-{build}-yaml.zip"

# Bump whenever _SCHEMA (or what convert() populates) changes shape. Stored as
# the sqlite file's own PRAGMA user_version, independent of the CCP build
# number — a stale schema must force a rebuild even if the CCP data itself
# hasn't changed since data/sde_build.txt was last written (that file tracks
# CCP freshness, not our schema, and isn't guaranteed to reflect what's
# actually baked into a given machine's untracked *.sqlite file).
_SCHEMA_VERSION = 2

_ROMAN = {
    1: "I", 2: "II", 3: "III", 4: "IV", 5: "V",
    6: "VI", 7: "VII", 8: "VIII", 9: "IX", 10: "X",
    11: "XI", 12: "XII", 13: "XIII", 14: "XIV", 15: "XV",
    16: "XVI", 17: "XVII", 18: "XVIII", 19: "XIX", 20: "XX",
}

_SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE invTypes (
    typeID        INTEGER PRIMARY KEY,
    typeName      TEXT,
    volume        REAL,
    published     INTEGER,
    marketGroupID INTEGER,
    groupID       INTEGER,
    portionSize   INTEGER
);
CREATE TABLE invGroups (
    groupID    INTEGER PRIMARY KEY,
    groupName  TEXT,
    categoryID INTEGER
);
CREATE TABLE staStations (
    stationID     INTEGER PRIMARY KEY,
    stationName   TEXT,
    solarSystemID INTEGER,
    regionID      INTEGER
);
CREATE TABLE mapSolarSystems (
    solarSystemID   INTEGER PRIMARY KEY,
    solarSystemName TEXT,
    regionID        INTEGER
);
CREATE TABLE typeMaterials (
    typeID         INTEGER,
    materialTypeID INTEGER,
    quantity       INTEGER,
    PRIMARY KEY (typeID, materialTypeID)
);
CREATE INDEX idx_invtypes_name ON invTypes(typeName);
CREATE INDEX idx_stations_name ON staStations(stationName);
CREATE INDEX idx_typematerials_type ON typeMaterials(typeID);
"""


def _en(obj) -> str:
    if isinstance(obj, dict):
        return obj.get("en") or next(iter(obj.values()), "") or ""
    return str(obj) if obj is not None else ""


def _load(zf: zipfile.ZipFile, name: str) -> dict:
    with zf.open(name) as f:
        return yaml.load(f, Loader=_YAML_LOADER)


def _station_name(s: dict, sys_name: str, corp_names: dict, op_names: dict) -> str:
    idx = s.get("celestialIndex", 0)
    orbit = s.get("orbitIndex")
    loc = f"{sys_name} {_ROMAN.get(idx, str(idx))}"
    if orbit is not None:
        loc += f" - Moon {orbit}"
    corp = corp_names.get(s.get("ownerID"), "")
    op = op_names.get(s.get("operationID"), "")
    suffix = f"{corp} {op}".strip()
    return f"{loc} - {suffix}" if suffix else loc


def _current_build(client: httpx.Client) -> str:
    resp = client.get(LATEST_URL, timeout=30)
    resp.raise_for_status()
    for line in resp.text.strip().splitlines():
        try:
            obj = json.loads(line)
            if obj.get("_key") == "sde":
                return str(obj["buildNumber"])
        except (json.JSONDecodeError, KeyError):
            continue
    raise RuntimeError(f"Could not parse build number from {LATEST_URL}")


def convert(zip_data: bytes, out: Path) -> None:
    print("  Parsing YAML...", flush=True)
    with zipfile.ZipFile(io.BytesIO(zip_data)) as zf:
        types_yaml = _load(zf, "types.yaml")
        groups_yaml = _load(zf, "groups.yaml")
        systems_yaml = _load(zf, "mapSolarSystems.yaml")
        stations_yaml = _load(zf, "npcStations.yaml")
        corps_yaml = _load(zf, "npcCorporations.yaml")
        ops_yaml = _load(zf, "stationOperations.yaml")
        materials_yaml = _load(zf, "typeMaterials.yaml")

    corp_names = {cid: _en(v.get("name")) for cid, v in corps_yaml.items()}
    op_names = {oid: _en(v.get("operationName")) for oid, v in ops_yaml.items()}
    sys_names = {sid: _en(v.get("name")) for sid, v in systems_yaml.items()}
    sys_regions = {sid: v.get("regionID") for sid, v in systems_yaml.items()}

    print("  Writing SQLite...", flush=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)

    db = sqlite3.connect(tmp)
    db.executescript(_SCHEMA)
    db.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")

    db.executemany(
        "INSERT OR IGNORE INTO invTypes VALUES (?,?,?,?,?,?,?)",
        [
            (
                tid,
                _en(v.get("name")),
                v.get("volume"),
                1 if v.get("published") else 0,
                v.get("marketGroupID"),
                v.get("groupID"),
                v.get("portionSize"),
            )
            for tid, v in types_yaml.items()
        ],
    )

    db.executemany(
        "INSERT OR IGNORE INTO typeMaterials VALUES (?,?,?)",
        [
            (tid, m["materialTypeID"], m["quantity"])
            for tid, v in materials_yaml.items()
            for m in (v.get("materials") or [])
        ],
    )

    db.executemany(
        "INSERT OR IGNORE INTO invGroups VALUES (?,?,?)",
        [
            (gid, _en(v.get("name")), v.get("categoryID"))
            for gid, v in groups_yaml.items()
        ],
    )

    db.executemany(
        "INSERT OR IGNORE INTO mapSolarSystems VALUES (?,?,?)",
        [
            (sid, _en(v.get("name")), v.get("regionID"))
            for sid, v in systems_yaml.items()
        ],
    )

    db.executemany(
        "INSERT OR IGNORE INTO staStations VALUES (?,?,?,?)",
        [
            (
                sid,
                _station_name(
                    s,
                    sys_names.get(s.get("solarSystemID"), ""),
                    corp_names,
                    op_names,
                ),
                s.get("solarSystemID"),
                sys_regions.get(s.get("solarSystemID")),
            )
            for sid, s in stations_yaml.items()
        ],
    )

    db.commit()
    db.close()
    tmp.replace(out)
    print(f"  Written to {out}", flush=True)


def _installed_schema_version(sde_path: Path) -> int | None:
    if not sde_path.exists():
        return None
    try:
        conn = sqlite3.connect(sde_path)
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        conn.close()
        return version
    except sqlite3.Error:
        return None


def main() -> None:
    sde_path = Path(os.getenv("SDE_PATH", "data/sqlite-latest.sqlite"))
    build_path = sde_path.with_name("sde_build.txt")

    stored = build_path.read_text().strip() if build_path.exists() else None
    schema_current = _installed_schema_version(sde_path) == _SCHEMA_VERSION

    print("Checking CCP SDE version...", flush=True)
    with httpx.Client(follow_redirects=True) as client:
        current = _current_build(client)
        print(f"  Latest build: {current}", flush=True)

        if stored == current and sde_path.exists() and schema_current:
            print("Already up to date.")
            return
        if stored == current and sde_path.exists() and not schema_current:
            print("  Build unchanged, but the local schema is outdated — rebuilding.", flush=True)

        url = ZIP_PATTERN.format(build=current)
        print(f"Downloading {url} ...", flush=True)
        resp = client.get(url, timeout=300)
        resp.raise_for_status()
        size_mb = len(resp.content) // 1024 // 1024
        print(f"  {size_mb} MB received", flush=True)

    convert(resp.content, sde_path)
    build_path.write_text(current)
    print(f"Done — build {current}")


if __name__ == "__main__":
    # Support running from project root
    if Path("backend").exists() and not Path("data").exists():
        os.chdir("backend")
    main()
