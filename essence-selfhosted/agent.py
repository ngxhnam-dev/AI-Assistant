"""bitHuman Essence avatar agent -- self-hosted with local .imx model.

Runs as a LiveKit agent. Place .imx model files in ./models/ directory.

Usage:
    python agent.py dev        # local dev with LiveKit playground
    python agent.py start      # production worker
"""

import asyncio
import logging
import os
import unicodedata
from pathlib import Path
from typing import Any

from bithuman.api import VideoControl
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RoomOutputOptions,
    UserInputTranscribedEvent,
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


KEYWORD_ACTION_MAP = {
    "xin chao": "mini_wave_hello",
    "chao": "mini_wave_hello",
    "hello": "mini_wave_hello",
    "haha": "laugh_react",
    "ha ha": "laugh_react",
    "buon cuoi": "laugh_react",
    "dung roi": "talk_head_nod_subtle",
    "dong y": "talk_head_nod_subtle",
    "chuc mung": "clap_cheer",
    "yeu": "heart_hands",
    "tam biet": "blow_kiss_heart",
}

def env_flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


DEFAULT_GESTURE_ACTION = os.getenv("DEFAULT_GESTURE_ACTION", "mini_wave_hello").strip()
TRIGGER_GESTURE_ON_ANY_INPUT = env_flag("TRIGGER_GESTURE_ON_ANY_INPUT", False)


def normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in normalized if not unicodedata.combining(ch)).lower().strip()


async def trigger_gesture(avatar: bithuman.AvatarSession, action: str):
    logger.info("Pushing gesture action: %s", action)
    await avatar.runtime.push(VideoControl(action=action))
    logger.info("Gesture push completed: %s", action)


async def entrypoint(ctx: JobContext):
    await ctx.connect()
    await ctx.wait_for_participant()
    logger.info("Participant connected, starting bitHuman self-hosted agent")

    # Find first .imx model in the configured directory
    model_root = os.getenv("IMX_MODEL_ROOT", "/imx-models")
    models = sorted(Path(model_root).glob("*.imx"))
    if not models:
        raise ValueError(
            f"No .imx models found in {model_root}. "
            "Download models from https://www.bithuman.ai and place them in ./models/"
        )
    logger.info("Loading model: %s", models[0])

    avatar = bithuman.AvatarSession(
        model_path=str(models[0]),
        api_secret=os.getenv("BITHUMAN_API_SECRET"),
    )
    logger.info("Avatar session created")

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
    logger.info("Agent session created")

    await avatar.start(session, room=ctx.room)
    logger.info("Avatar session started")

    @session.on("user_input_transcribed")
    def on_user_input_transcribed(event: UserInputTranscribedEvent):
        if not event.is_final:
            return

        transcript = event.transcript.strip()
        normalized_transcript = normalize_text(transcript)
        logger.info("Final transcript received: %s", transcript)
        logger.info("Normalized transcript: %s", normalized_transcript)

        for keyword, action in KEYWORD_ACTION_MAP.items():
            if normalize_text(keyword) in normalized_transcript:
                logger.info("Matched keyword '%s' -> action '%s'", keyword, action)
                asyncio.create_task(trigger_gesture(avatar, action))
                break
        else:
            if TRIGGER_GESTURE_ON_ANY_INPUT and DEFAULT_GESTURE_ACTION:
                logger.info(
                    "No keyword matched. Falling back to default gesture '%s'",
                    DEFAULT_GESTURE_ACTION,
                )
                asyncio.create_task(trigger_gesture(avatar, DEFAULT_GESTURE_ACTION))
            else:
                logger.info("No gesture keyword matched transcript")

    await session.start(
        agent=Agent(
            instructions=os.getenv("AGENT_PROMPT", "You are a helpful assistant. Respond concisely.")
        ),
        room=ctx.room,
        room_output_options=RoomOutputOptions(audio_enabled=True),
    )
    logger.info("Agent session fully started")


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

    cli.run_app(WorkerOptions(**worker_options))
