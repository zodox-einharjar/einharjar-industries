from fastapi import APIRouter, Depends
from sqlalchemy import select

from ..auth.deps import get_current_character
from ..db import AsyncSessionLocal
from ..esi.client import esi
from ..models import Character, IndustryJob, IndustryProject, ProjectJob
from ..sde import station_name, type_names

router = APIRouter(prefix="/industry/jobs", dependencies=[Depends(get_current_character)])

_NPC_STATION_MAX = 1_000_000_000

_ACTIVITY_LABELS = {
    1: "Manufacturing",
    3: "Time Efficiency Research",
    4: "Material Efficiency Research",
    5: "Copying",
    7: "Reverse Engineering",
    8: "Invention",
    9: "Reactions",
}


def _loc_name(loc_id: int | None) -> str | None:
    if loc_id is None:
        return None
    if loc_id < _NPC_STATION_MAX:
        return station_name(loc_id)
    return None


@router.get("")
async def list_jobs():
    async with AsyncSessionLocal() as session:
        jobs = (await session.execute(select(IndustryJob))).scalars().all()
        all_chars = (await session.execute(select(Character))).scalars().all()

        project_by_job_id: dict[int, dict] = {}
        if jobs:
            rows = (await session.execute(
                select(ProjectJob.industry_job_id, IndustryProject.id, IndustryProject.name)
                .join(IndustryProject, ProjectJob.project_id == IndustryProject.id)
                .where(ProjectJob.industry_job_id.in_([j.id for j in jobs]))
            )).all()
            project_by_job_id = {
                industry_job_id: {"project_id": project_id, "project_name": project_name}
                for industry_job_id, project_id, project_name in rows
            }

    char_name_by_id = {c.character_id: c.character_name for c in all_chars}

    unknown_ids = {
        j.installer_id for j in jobs if j.installer_id not in char_name_by_id
    } | {
        j.completed_character_id for j in jobs
        if j.completed_character_id and j.completed_character_id not in char_name_by_id
    }
    resolved = await esi.resolve_names(list(unknown_ids))
    name_by_id = {**char_name_by_id, **resolved}

    type_ids = list({j.blueprint_type_id for j in jobs} | {j.product_type_id for j in jobs if j.product_type_id})
    names = type_names(type_ids)

    result = []
    for j in jobs:
        linked_project = project_by_job_id.get(j.id)
        result.append({
            "id": j.id,
            "job_id": j.job_id,
            "project_id": linked_project["project_id"] if linked_project else None,
            "project_name": linked_project["project_name"] if linked_project else None,
            "source": j.source,
            "activity_id": j.activity_id,
            "activity_name": _ACTIVITY_LABELS.get(j.activity_id, "Unknown"),
            "installer_id": j.installer_id,
            "installer_name": name_by_id.get(j.installer_id),
            "blueprint_type_id": j.blueprint_type_id,
            "blueprint_name": names.get(j.blueprint_type_id),
            "product_type_id": j.product_type_id,
            "product_name": names.get(j.product_type_id) if j.product_type_id else None,
            "runs": j.runs,
            "licensed_runs": j.licensed_runs,
            "cost": float(j.cost) if j.cost is not None else None,
            "probability": j.probability,
            "successful_runs": j.successful_runs,
            "status": j.status,
            "duration": j.duration,
            "start_date": j.start_date.isoformat(),
            "end_date": j.end_date.isoformat(),
            "pause_date": j.pause_date.isoformat() if j.pause_date else None,
            "completed_date": j.completed_date.isoformat() if j.completed_date else None,
            "completed_character_id": j.completed_character_id,
            "completed_character_name": name_by_id.get(j.completed_character_id) if j.completed_character_id else None,
            "facility_name": _loc_name(j.facility_id),
            "output_location_name": _loc_name(j.output_location_id),
            "last_synced": j.last_synced.isoformat(),
        })

    result.sort(key=lambda x: x["end_date"], reverse=True)
    return result


@router.post("/sync")
async def sync_now():
    from ..industry_jobs.poller import poll_industry_jobs
    stats = await poll_industry_jobs()
    return {"ok": True, "count": stats["count"]}
