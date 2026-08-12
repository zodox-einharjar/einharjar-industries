import logging

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

_API_BASE = "https://discord.com/api/v10"


async def notify(content: str) -> None:
    """Post a plain message to the configured Discord notification channel.

    Uses the bot REST API directly rather than the gateway — notifications
    are fire-and-forget from the backend's pollers and don't need the
    always-on bot process to be connected.
    """
    if not settings.discord_bot_token or not settings.discord_notify_channel_id:
        logger.warning("Discord notify skipped (bot token/channel not configured): %s", content)
        return

    url = f"{_API_BASE}/channels/{settings.discord_notify_channel_id}/messages"
    headers = {"Authorization": f"Bot {settings.discord_bot_token}"}

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            response = await client.post(url, headers=headers, json={"content": content})
            response.raise_for_status()
        except httpx.HTTPError:
            logger.exception("Failed to send Discord notification")
