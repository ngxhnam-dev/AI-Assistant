"""bitHuman Essence avatar agent -- self-hosted with local .imx model.

Runs as a LiveKit agent. Place .imx model files in ./models/ directory.

Usage:
    python agent.py dev        # local dev with LiveKit playground
    python agent.py start      # production worker
"""

import logging
import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
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

logger = logging.getLogger("bithuman-agent")
logger.setLevel(logging.INFO)

load_dotenv()


def env_flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


async def entrypoint(ctx: JobContext):
    await ctx.connect()
    await ctx.wait_for_participant()

    # Find first .imx model in the configured directory
    model_root = os.getenv("IMX_MODEL_ROOT", "/imx-models")
    models = sorted(Path(model_root).glob("*.imx"))
    if not models:
        raise ValueError(
            f"No .imx models found in {model_root}. "
            "Download models from https://www.bithuman.ai and place them in ./models/"
        )
    logger.info(f"Loading model: {models[0]}")

    avatar = bithuman.AvatarSession(
        model_path=str(models[0]),
        api_secret=os.getenv("BITHUMAN_API_SECRET"),
    )

    session_kwargs: dict[str, Any] = {
        "llm": openai.realtime.RealtimeModel(
            voice=os.getenv("OPENAI_VOICE", "coral"),
            model="gpt-4o-mini-realtime-preview",
        )
    }

    use_local_vad = env_flag("BITHUMAN_ENABLE_LOCAL_VAD", False)
    if use_local_vad:
        logger.info("Loading local Silero VAD")
        session_kwargs["vad"] = silero.VAD.load()
    else:
        logger.info("Local Silero VAD disabled")

    session = AgentSession(**session_kwargs)

    await avatar.start(session, room=ctx.room)

    await session.start(
        agent=Agent(
            instructions=os.getenv("AGENT_PROMPT", "You are a helpful assistant. Respond concisely.")
        ),
        room=ctx.room,
        room_output_options=RoomOutputOptions(audio_enabled=True),
    )


if __name__ == "__main__":
    worker_options = dict(
        entrypoint_fnc=entrypoint,
        worker_type=WorkerType.ROOM,
        job_memory_warn_mb=1500,
        num_idle_processes=int(os.getenv("LIVEKIT_NUM_IDLE_PROCESSES", "0")),
    )

    agent_name = os.getenv("LIVEKIT_AGENT_NAME", "").strip()
    if agent_name:
        worker_options["agent_name"] = agent_name

    cli.run_app(
        WorkerOptions(**worker_options)
    )
