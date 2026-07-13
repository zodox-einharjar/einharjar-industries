from dataclasses import asdict, dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from ..models import Doctrine, DoctrineFit, Fit, FitItem
from .html_import import ParsedDoctrine, ParsedFit


@dataclass
class FitPlanEntry:
    action: str  # create | update | keep | delete | error
    source_fit_name: str
    fit_name: str | None
    fit_id: int | None
    ship_name: str | None
    item_count: int
    target_qty_before: int | None
    target_qty_after: int | None
    error: str | None = None
    warning: str | None = None


@dataclass
class DoctrinePlanEntry:
    action: str  # create | update | delete
    name: str
    doctrine_id: int | None
    fits: list[FitPlanEntry] = field(default_factory=list)


@dataclass
class ImportPlan:
    doctrines: list[DoctrinePlanEntry]
    orphan_fits_deleted: list[str]
    duplicate_doctrine_names: list[str]
    duplicate_fit_names: list[str]
    summary: dict[str, int]

    def as_dict(self) -> dict:
        return {
            "doctrines": [asdict(d) for d in self.doctrines],
            "orphan_fits_deleted": self.orphan_fits_deleted,
            "duplicate_doctrine_names": self.duplicate_doctrine_names,
            "duplicate_fit_names": self.duplicate_fit_names,
            "summary": self.summary,
        }


_DOCTRINE_OPTS = (
    selectinload(Doctrine.doctrine_fits).options(
        selectinload(DoctrineFit.fit).options(selectinload(Fit.items))
    ),
)


async def build_and_apply_plan(session, parsed_doctrines: list[ParsedDoctrine], *, dry_run: bool) -> ImportPlan:
    existing_doctrines = (await session.execute(
        select(Doctrine).options(*_DOCTRINE_OPTS)
    )).scalars().all()
    existing_by_name: dict[str, Doctrine] = {d.name.lower(): d for d in existing_doctrines}

    existing_fits = (await session.execute(
        select(Fit).options(selectinload(Fit.items))
    )).scalars().all()
    fits_by_name: dict[str, Fit] = {f.name.lower(): f for f in existing_fits}

    # Dedup parsed doctrines by name (case-insensitive) — first occurrence wins.
    seen_doctrine_names: set[str] = set()
    duplicate_doctrine_names: list[str] = []
    dedup_doctrines: list[ParsedDoctrine] = []
    for pd in parsed_doctrines:
        key = pd.name.strip().lower()
        if key in seen_doctrine_names:
            duplicate_doctrine_names.append(pd.name)
            continue
        seen_doctrine_names.add(key)
        dedup_doctrines.append(pd)

    duplicate_fit_names: list[str] = []
    plan_doctrines: list[DoctrinePlanEntry] = []
    processed_doctrine_names: set[str] = set()

    for pd in dedup_doctrines:
        name_key = pd.name.strip().lower()
        processed_doctrine_names.add(name_key)
        existing_doc = existing_by_name.get(name_key)

        if existing_doc:
            action = "update"
            doctrine_row = existing_doc
        else:
            action = "create"
            # doctrine_fits=[] avoids an implicit lazy-load (unsupported under AsyncSession)
            # when this relationship is read below, right after the flush gives it an identity.
            doctrine_row = Doctrine(name=pd.name, description=None, location_id=None, doctrine_fits=[])
            session.add(doctrine_row)
            await session.flush()

        # Dedup fits within this doctrine by parsed fit name (case-insensitive).
        # Fits that failed to parse have no fit_name and are never deduped.
        seen_fit_names: set[str] = set()
        dedup_fits: list[ParsedFit] = []
        for pf in pd.fits:
            if pf.parse_error or not pf.fit_name:
                dedup_fits.append(pf)
                continue
            fkey = pf.fit_name.strip().lower()
            if fkey in seen_fit_names:
                duplicate_fit_names.append(f"{pd.name} / {pf.fit_name}")
                continue
            seen_fit_names.add(fkey)
            dedup_fits.append(pf)

        existing_dfs_by_fit_name: dict[str, DoctrineFit] = {
            df.fit.name.lower(): df for df in doctrine_row.doctrine_fits
        }
        kept_fit_name_keys: set[str] = set()
        fit_entries: list[FitPlanEntry] = []

        for pf in dedup_fits:
            item_count = len(pf.items)
            if pf.parse_error:
                fit_entries.append(FitPlanEntry(
                    action="error",
                    source_fit_name=pf.source_fit_name,
                    fit_name=pf.fit_name,
                    fit_id=None,
                    ship_name=pf.ship_name,
                    item_count=item_count,
                    target_qty_before=None,
                    target_qty_after=None,
                    error=pf.parse_error,
                    warning=pf.target_warning,
                ))
                continue

            fkey = pf.fit_name.strip().lower()
            kept_fit_name_keys.add(fkey)
            existing_fit = fits_by_name.get(fkey)

            if existing_fit:
                changed = (
                    existing_fit.ship_type_id != pf.ship_type_id
                    or {i.type_id: i.quantity for i in existing_fit.items} != pf.items
                )
                if changed:
                    existing_fit.name = pf.fit_name
                    existing_fit.ship_type_id = pf.ship_type_id
                    existing_fit.raw_eft = pf.raw_eft
                    existing_fit.items.clear()
                    for type_id, qty in pf.items.items():
                        existing_fit.items.append(FitItem(type_id=type_id, quantity=qty))
                    fit_action = "update"
                else:
                    fit_action = "keep"
                fit_row = existing_fit
            else:
                # items=[] populates the relationship in-memory (see doctrine_fits=[] note above);
                # appending via the relationship (not a raw FitItem(fit_id=...)) keeps it in sync
                # so a later re-encounter of the same fit (shared across doctrines) reads correctly.
                fit_row = Fit(name=pf.fit_name, ship_type_id=pf.ship_type_id, raw_eft=pf.raw_eft, items=[])
                for type_id, qty in pf.items.items():
                    fit_row.items.append(FitItem(type_id=type_id, quantity=qty))
                session.add(fit_row)
                await session.flush()
                fits_by_name[fkey] = fit_row
                fit_action = "create"

            await session.flush()

            existing_df = existing_dfs_by_fit_name.get(fkey)
            target_before = existing_df.target_qty if existing_df else None
            if existing_df:
                existing_df.fit_id = fit_row.id
                if existing_df.target_qty != pf.target_qty:
                    existing_df.target_qty = pf.target_qty
                    if fit_action == "keep":
                        fit_action = "update"
            else:
                session.add(DoctrineFit(doctrine_id=doctrine_row.id, fit_id=fit_row.id, target_qty=pf.target_qty))
                await session.flush()

            fit_entries.append(FitPlanEntry(
                action=fit_action,
                source_fit_name=pf.source_fit_name,
                fit_name=pf.fit_name,
                fit_id=fit_row.id,
                ship_name=pf.ship_name,
                item_count=item_count,
                target_qty_before=target_before,
                target_qty_after=pf.target_qty,
                warning=pf.target_warning,
            ))

        # DoctrineFit links whose fit is no longer in this doctrine's parsed set → delete.
        for fkey, df in existing_dfs_by_fit_name.items():
            if fkey in kept_fit_name_keys:
                continue
            fit_entries.append(FitPlanEntry(
                action="delete",
                source_fit_name=df.fit.name,
                fit_name=df.fit.name,
                fit_id=df.fit.id,
                ship_name=None,
                item_count=len(df.fit.items),
                target_qty_before=df.target_qty,
                target_qty_after=None,
            ))
            await session.delete(df)

        plan_doctrines.append(DoctrinePlanEntry(
            action=action,
            name=pd.name,
            doctrine_id=doctrine_row.id,
            fits=fit_entries,
        ))

    # Doctrines that exist but weren't present in the paste at all → full delete.
    for name_key, doc in existing_by_name.items():
        if name_key in processed_doctrine_names:
            continue
        fit_entries = [
            FitPlanEntry(
                action="delete",
                source_fit_name=df.fit.name,
                fit_name=df.fit.name,
                fit_id=df.fit.id,
                ship_name=None,
                item_count=len(df.fit.items),
                target_qty_before=df.target_qty,
                target_qty_after=None,
            )
            for df in doc.doctrine_fits
        ]
        plan_doctrines.append(DoctrinePlanEntry(
            action="delete",
            name=doc.name,
            doctrine_id=doc.id,
            fits=fit_entries,
        ))
        await session.delete(doc)

    await session.flush()

    # Orphan cleanup: fits with zero remaining DoctrineFit references.
    orphan_fits = (await session.execute(
        select(Fit).outerjoin(Fit.doctrine_fits).where(DoctrineFit.id.is_(None))
    )).scalars().all()
    orphan_names = [f.name for f in orphan_fits]
    for f in orphan_fits:
        await session.delete(f)

    await session.flush()

    if dry_run:
        await session.rollback()
    else:
        await session.commit()

    summary = {
        "doctrines_created": sum(1 for d in plan_doctrines if d.action == "create"),
        "doctrines_updated": sum(1 for d in plan_doctrines if d.action == "update"),
        "doctrines_deleted": sum(1 for d in plan_doctrines if d.action == "delete"),
        "fits_created": sum(1 for d in plan_doctrines for f in d.fits if f.action == "create"),
        "fits_updated": sum(1 for d in plan_doctrines for f in d.fits if f.action == "update"),
        "fits_kept": sum(1 for d in plan_doctrines for f in d.fits if f.action == "keep"),
        "fits_deleted": sum(1 for d in plan_doctrines for f in d.fits if f.action == "delete"),
        "fits_errored": sum(1 for d in plan_doctrines for f in d.fits if f.action == "error"),
        "orphan_fits_deleted": len(orphan_names),
    }

    return ImportPlan(
        doctrines=plan_doctrines,
        orphan_fits_deleted=orphan_names,
        duplicate_doctrine_names=duplicate_doctrine_names,
        duplicate_fit_names=duplicate_fit_names,
        summary=summary,
    )
