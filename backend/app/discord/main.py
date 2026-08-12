import logging

import discord

from ..config import settings
from .bot import bot

logger = logging.getLogger(__name__)


@bot.event
async def on_ready():
    if settings.discord_guild_id:
        guild = discord.Object(id=int(settings.discord_guild_id))
        bot.tree.copy_global_to(guild=guild)
        await bot.tree.sync(guild=guild)
    else:
        await bot.tree.sync()
    logger.info("Discord bot ready as %s", bot.user)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    if not settings.discord_bot_token:
        raise RuntimeError("DISCORD_BOT_TOKEN is not configured")
    bot.run(settings.discord_bot_token)


if __name__ == "__main__":
    main()
