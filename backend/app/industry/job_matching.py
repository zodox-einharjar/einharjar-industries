from sqlalchemy import select
from sqlalchemy.orm import selectinload

from ..models import IndustryJob, IndustryProject, ProjectJob
from ..sde import type_id_by_name

_MATCHABLE_STATUSES = ("active", "paused", "ready")
_UNLINK_STATUSES = ("cancelled", "reverted")


async def relink_project_jobs(session, project_ids: list[int] | None = None) -> dict:
    """Auto-link unlinked ProjectJob rows (planning/in_progress projects) to
    unlinked in-flight IndustryJob rows, matched by resolved item type_id.

    Within a type_id group: pass 1 pairs exact runs-count matches (in
    ProjectJob.sort_order / IndustryJob.start_date order), pass 2 pairs
    whatever's left positionally, top to bottom. Never touches a ProjectJob
    or IndustryJob that's already linked.
    """
    project_query = select(IndustryProject).where(
        IndustryProject.status.in_(["planning", "in_progress"])
    )
    if project_ids:
        project_query = project_query.where(IndustryProject.id.in_(project_ids))
    projects = (await session.execute(
        project_query.options(selectinload(IndustryProject.jobs))
    )).scalars().all()

    unlinked_pjobs = [j for p in projects for j in p.jobs if j.industry_job_id is None]
    if not unlinked_pjobs:
        return {"linked": 0}

    globally_linked = set((await session.execute(
        select(ProjectJob.industry_job_id).where(ProjectJob.industry_job_id.is_not(None))
    )).scalars().all())

    ijobs = (await session.execute(
        select(IndustryJob).where(IndustryJob.status.in_(_MATCHABLE_STATUSES))
    )).scalars().all()
    ijobs = [j for j in ijobs if j.id not in globally_linked]

    pjobs_by_type: dict[int, list[ProjectJob]] = {}
    for j in unlinked_pjobs:
        tid = type_id_by_name(j.name)
        if tid is not None:
            pjobs_by_type.setdefault(tid, []).append(j)
    for lst in pjobs_by_type.values():
        lst.sort(key=lambda j: j.sort_order)

    ijobs_by_type: dict[int, list[IndustryJob]] = {}
    for ij in ijobs:
        # ProjectJob.name is always a *blueprint* name (the paste format is
        # "Blueprint Name / Runs / Days / Job Cost", e.g. "Vexor Blueprint") — key
        # real jobs the same way, not by the item they're producing, or every
        # manufacturing/reaction job (whose product differs from its blueprint)
        # would silently fail to match.
        ijobs_by_type.setdefault(ij.blueprint_type_id, []).append(ij)
    for lst in ijobs_by_type.values():
        lst.sort(key=lambda ij: ij.start_date)

    linked = 0
    for tid, pjobs in pjobs_by_type.items():
        candidates = ijobs_by_type.get(tid)
        if not candidates:
            continue
        remaining_p = list(pjobs)
        remaining_i = list(candidates)

        for pj in list(remaining_p):
            match = next((ij for ij in remaining_i if ij.runs == pj.runs), None)
            if match:
                pj.industry_job_id = match.id
                remaining_p.remove(pj)
                remaining_i.remove(match)
                linked += 1

        for pj, ij in zip(remaining_p, remaining_i):
            pj.industry_job_id = ij.id
            linked += 1

    await session.commit()
    return {"linked": linked}


async def unlink_stale_project_jobs(session) -> dict:
    """Clear links whose real job cancelled/reverted, reverting to the manual estimate."""
    linked_jobs = (await session.execute(
        select(ProjectJob)
        .where(ProjectJob.industry_job_id.is_not(None))
        .options(selectinload(ProjectJob.linked_job))
    )).scalars().all()

    unlinked = 0
    for pj in linked_jobs:
        if pj.linked_job and pj.linked_job.status in _UNLINK_STATUSES:
            pj.industry_job_id = None
            unlinked += 1

    if unlinked:
        await session.commit()
    return {"unlinked": unlinked}
