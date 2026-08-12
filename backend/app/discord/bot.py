import logging

import discord
from discord import app_commands
from discord.ext import commands
from sqlalchemy import func, select

from ..config import settings
from ..db import AsyncSessionLocal
from ..doctrines.router import compute_doctrine_report
from ..market_listings.router import compute_listing_report
from ..models import Doctrine
from ..templates import _fmt_iska

logger = logging.getLogger(__name__)

intents = discord.Intents.default()
bot = commands.Bot(command_prefix="!", intents=intents)

_STATUS_EMOJI = {"ready": "🟢", "partial": "🟡", "short": "🔴", "unknown": "⚪"}


def _is_allowed(interaction: discord.Interaction) -> bool:
    allowed = settings.discord_allowed_user_id
    return bool(allowed) and str(interaction.user.id) == allowed


async def _build_market_embed() -> discord.Embed:
    async with AsyncSessionLocal() as session:
        listings = await compute_listing_report(session)

    embed = discord.Embed(title="Market Listings Report", color=discord.Color.blurple())
    if not listings:
        embed.description = "No active market listings."
        return embed

    undercut_count = sum(1 for l in listings if l["is_undercut"])
    embed.description = f"{len(listings)} active listing(s) — {undercut_count} undercut"

    for listing in listings[:25]:
        flag = "⚠️ undercut" if listing["is_undercut"] else "ok"
        lines = [f"{listing['location_name']} — {_fmt_iska(listing['list_price'])} ISK ({flag})"]
        if listing["market_low"] is not None:
            lines.append(f"market low: {_fmt_iska(listing['market_low'])}")
        embed.add_field(name=listing["item_name"], value="\n".join(lines), inline=True)

    if len(listings) > 25:
        embed.set_footer(text=f"Showing 25 of {len(listings)} listings")

    return embed


def _fit_line(f: dict) -> str:
    emoji = _STATUS_EMOJI.get(f["status"], "⚪")
    stock = f["stock"] if f["stock"] is not None else "?"
    return f"{emoji} **{f['name']}** — `{stock}/{f['target']}` · {_fmt_iska(f['price'])} ISK"


async def _build_doctrine_embed(name: str | None) -> discord.Embed:
    async with AsyncSessionLocal() as session:
        doctrine_id = None
        if name:
            doctrine = (await session.execute(
                select(Doctrine).where(func.lower(Doctrine.name) == name.lower())
            )).scalar_one_or_none()
            if not doctrine:
                embed = discord.Embed(title="Doctrine Stock Report", color=discord.Color.red())
                embed.description = f"No doctrine found matching '{name}'."
                return embed
            doctrine_id = doctrine.id

        report = await compute_doctrine_report(session, doctrine_id=doctrine_id)

    # Single doctrine: give it the embed's own title instead of a field, so it
    # reads as a clear header above the fit rows rather than another list item.
    if doctrine_id is not None:
        d = report["doctrine_summary"][0]
        emoji = _STATUS_EMOJI.get(d["status"], "⚪")
        embed = discord.Embed(title=f"{emoji} {d['name']}", color=discord.Color.gold())
        embed.description = "\n".join(_fit_line(f) for f in d["fits"]) or "(no fits)"
        return embed

    embed = discord.Embed(title="Doctrine Stock Report", color=discord.Color.gold())
    embed.description = (
        f"{report['doctrines_fully_stocked']}/{report['doctrine_count']} doctrines fully stocked "
        f"— {report['fits_below_target']} fit(s) below target"
    )

    for d in report["doctrine_summary"][:25]:
        emoji = _STATUS_EMOJI.get(d["status"], "⚪")
        value = "\n".join(_fit_line(f) for f in d["fits"]) or "(no fits)"
        embed.add_field(name=f"{emoji}  {d['name']}", value=value, inline=False)

    return embed


report_group = app_commands.Group(name="report", description="Generate reports from the trading app")


@report_group.command(name="market", description="Active market listing competitiveness report")
async def report_market(interaction: discord.Interaction):
    if not _is_allowed(interaction):
        await interaction.response.send_message("Not authorized.", ephemeral=True)
        return
    await interaction.response.defer(thinking=True)
    await interaction.followup.send(embed=await _build_market_embed())


@report_group.command(name="doctrine", description="Doctrine stock status report")
@app_commands.describe(name="Optional doctrine name to filter to a single doctrine")
async def report_doctrine(interaction: discord.Interaction, name: str | None = None):
    if not _is_allowed(interaction):
        await interaction.response.send_message("Not authorized.", ephemeral=True)
        return
    await interaction.response.defer(thinking=True)
    await interaction.followup.send(embed=await _build_doctrine_embed(name))


bot.tree.add_command(report_group)
