"""bitHuman Essence avatar agent -- cloud-hosted (no local models needed).

Usage:
    python agent.py dev        # local dev with LiveKit playground
    python agent.py start      # production worker
"""

import asyncio
import json
import logging
import os
from datetime import datetime

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RoomOutputOptions,
    WorkerOptions,
    WorkerType,
    cli,
)
from livekit.plugins import bithuman, openai, silero

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)

logger = logging.getLogger("bithuman-agent")
logger.setLevel(logging.INFO)

load_dotenv()


def get_avatar_identities(room: rtc.Room) -> list[str]:
    return [
        identity
        for identity in room.remote_participants.keys()
        if identity.startswith("bithuman-avatar")
    ]


async def trigger_dynamics(
    local_participant: rtc.LocalParticipant,
    destination_identity: str,
    action: str,
) -> None:
    logger.info(
        "Sending trigger_dynamics '%s' from '%s' to '%s'",
        action,
        local_participant.identity,
        destination_identity,
    )
    await local_participant.perform_rpc(
        destination_identity=destination_identity,
        method="trigger_dynamics",
        payload=json.dumps(
            {
                "action": action,
                "identity": local_participant.identity,
                "timestamp": datetime.utcnow().isoformat(),
            }
        ),
    )
    logger.info("trigger_dynamics sent successfully: %s -> %s", action, destination_identity)


def schedule_gesture(room: rtc.Room, action: str) -> None:
    avatar_identities = get_avatar_identities(room)
    if not avatar_identities:
        logger.warning(
            "No bitHuman avatar participant found for gesture '%s'. Remote identities: %s",
            action,
            list(room.remote_participants.keys()),
        )
        return

    for identity in avatar_identities:
        asyncio.create_task(
            trigger_dynamics(
                room.local_participant,
                identity,
                action,
            )
        )


async def entrypoint(ctx: JobContext):
    await ctx.connect()
    await ctx.wait_for_participant()

    avatar_id = os.getenv("BITHUMAN_AGENT_ID")
    if not avatar_id:
        raise ValueError(
            "Set BITHUMAN_AGENT_ID in your .env file. "
            "Create an agent at https://www.bithuman.ai or via api/generation.py"
        )

    logger.info(f"Cloud Essence mode -- avatar_id: {avatar_id}")

    avatar = bithuman.AvatarSession(
        avatar_id=avatar_id,
        api_secret=os.getenv("BITHUMAN_API_SECRET"),
    )

    session = AgentSession(
        llm=openai.realtime.RealtimeModel(
            voice=os.getenv("OPENAI_VOICE", "coral"),
            model="gpt-4o-mini-realtime-preview",
        ),
        vad=silero.VAD.load(),
    )

    await avatar.start(session, room=ctx.room)

    await session.start(
        agent=Agent(
            instructions=os.getenv("AGENT_PROMPT", "You are a helpful assistant. Respond concisely.")
        ),
        room=ctx.room,
        room_output_options=RoomOutputOptions(audio_enabled=False),
    )

if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            worker_type=WorkerType.ROOM,
            job_memory_warn_mb=1500,
            num_idle_processes=1,
        )
    )
