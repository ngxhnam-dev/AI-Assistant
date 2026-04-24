"""bitHuman Essence avatar agent -- cloud-hosted (no local models needed).

Usage:
    python agent.py dev        # local dev with LiveKit playground
    python agent.py start      # production worker
"""

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime

import requests
from elevenlabs import VoiceSettings
from elevenlabs.client import AsyncElevenLabs
from dotenv import load_dotenv
from livekit import rtc
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
from livekit.agents.tts.tts import (
    APIConnectOptions,
    AudioEmitter,
    ChunkedStream,
    DEFAULT_API_CONNECT_OPTIONS,
    TTS,
    TTSCapabilities,
)
from livekit.plugins import bithuman, openai, silero

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)

logger = logging.getLogger("bithuman-agent")
logger.setLevel(logging.INFO)

load_dotenv()

RAG_URL = os.getenv("RAG_URL", "https://hub.advietnam.vn/v1/chat-messages").strip()
RAG_API_KEY = os.getenv("RAG_API_KEY", "").strip()
RAG_USER_PREFIX = os.getenv("RAG_USER_PREFIX", "bithuman").strip()
RAG_CONVERSATIONS: dict[str, str] = {}
TURN_HISTORY_TOPIC = "turn_history"
TURN_HISTORY_COUNTERS: dict[str, int] = {}


def _env_float(name: str) -> float | None:
    raw_value = os.getenv(name, "").strip()
    if not raw_value:
        return None
    try:
        return float(raw_value)
    except ValueError as exc:
        raise ValueError(f"Invalid float for {name}: {raw_value!r}") from exc


def _env_bool(name: str, default: bool = False) -> bool:
    raw_value = os.getenv(name, "").strip().lower()
    if not raw_value:
        return default
    return raw_value in {"1", "true", "yes", "on"}


def _build_voice_settings() -> VoiceSettings | None:
    kwargs: dict[str, object] = {}

    stability = _env_float("ELEVENLABS_STABILITY")
    similarity_boost = _env_float("ELEVENLABS_SIMILARITY_BOOST")
    style = _env_float("ELEVENLABS_STYLE")
    speed = _env_float("ELEVENLABS_SPEED")
    use_speaker_boost = os.getenv("ELEVENLABS_USE_SPEAKER_BOOST", "").strip()

    if stability is not None:
        kwargs["stability"] = stability
    if similarity_boost is not None:
        kwargs["similarity_boost"] = similarity_boost
    if style is not None:
        kwargs["style"] = style
    if speed is not None:
        kwargs["speed"] = speed
    if use_speaker_boost:
        kwargs["use_speaker_boost"] = _env_bool("ELEVENLABS_USE_SPEAKER_BOOST")

    if not kwargs:
        return None

    return VoiceSettings(**kwargs)


class ElevenLabsTTS(TTS):
    def __init__(
        self,
        *,
        api_key: str,
        voice_id: str,
        model_id: str,
        language_code: str | None,
        output_format: str,
        voice_settings: VoiceSettings | None = None,
    ) -> None:
        super().__init__(
            capabilities=TTSCapabilities(streaming=False),
            sample_rate=16000,
            num_channels=1,
        )
        self._client = AsyncElevenLabs(api_key=api_key)
        self._voice_id = voice_id
        self._model_id = model_id
        self._language_code = language_code
        self._output_format = output_format
        self._voice_settings = voice_settings

    @property
    def model(self) -> str:
        return self._model_id

    @property
    def provider(self) -> str:
        return "elevenlabs"

    def synthesize(
        self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS
    ) -> ChunkedStream:
        return ElevenLabsChunkedStream(tts=self, input_text=text, conn_options=conn_options)


class ElevenLabsChunkedStream(ChunkedStream):
    def __init__(
        self,
        *,
        tts: ElevenLabsTTS,
        input_text: str,
        conn_options: APIConnectOptions,
    ) -> None:
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._tts = tts

    async def _run(self, output_emitter: AudioEmitter) -> None:
        output_emitter.initialize(
            request_id=uuid.uuid4().hex,
            sample_rate=self._tts.sample_rate,
            num_channels=self._tts.num_channels,
            mime_type="audio/pcm",
        )

        try:
            stream = self._tts._client.text_to_speech.stream(
                voice_id=self._tts._voice_id,
                text=self.input_text,
                model_id=self._tts._model_id,
                voice_settings=self._tts._voice_settings,
                output_format=self._tts._output_format,
                apply_text_normalization="auto",
                **(
                    {"language_code": self._tts._language_code}
                    if self._tts._language_code
                    else {}
                ),
            )

            async for chunk in stream:
                if chunk:
                    output_emitter.push(chunk)

            output_emitter.flush()
        except Exception as exc:
            raise RuntimeError(f"ElevenLabs TTS failed: {exc}") from exc


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


async def publish_turn_history(room: rtc.Room, role: str, content: str) -> None:
    room_key = room.name
    TURN_HISTORY_COUNTERS[room_key] = TURN_HISTORY_COUNTERS.get(room_key, 0) + 1
    payload = json.dumps(
        {
            "type": "turn_history",
            "room": room_key,
            "order": TURN_HISTORY_COUNTERS[room_key],
            "role": role,
            "content": content,
        },
        ensure_ascii=False,
    )
    await room.local_participant.publish_data(payload, topic=TURN_HISTORY_TOPIC)


def _extract_rag_text(payload: object) -> tuple[str, str | None]:
    if not isinstance(payload, dict):
        return "", None

    for key in ("answer", "text", "content", "message"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip(), payload.get("conversation_id") if isinstance(payload.get("conversation_id"), str) else None

    data = payload.get("data")
    if isinstance(data, dict):
        for key in ("answer", "text", "content", "message"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                conversation_id = data.get("conversation_id")
                if not isinstance(conversation_id, str):
                    conversation_id = payload.get("conversation_id") if isinstance(payload.get("conversation_id"), str) else None
                return value.strip(), conversation_id

    conversation_id = payload.get("conversation_id")
    if not isinstance(conversation_id, str):
        conversation_id = None
    return "", conversation_id


def _parse_rag_response(response: requests.Response) -> tuple[str, str | None]:
    chunks: list[str] = []
    conversation_id: str | None = None

    content_type = response.headers.get("content-type", "")
    if "text/event-stream" in content_type or "application/json" not in content_type:
        for raw_line in response.iter_lines(decode_unicode=True):
            if not raw_line:
                continue

            line = raw_line.strip()
            if not line.startswith("data:"):
                continue

            payload = line[5:].strip()
            if not payload or payload == "[DONE]":
                continue

            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                continue

            text, next_conversation_id = _extract_rag_text(parsed)
            if text:
                chunks.append(text)
            if next_conversation_id:
                conversation_id = next_conversation_id
    else:
        try:
            parsed = response.json()
        except ValueError:
            parsed = None

        text, next_conversation_id = _extract_rag_text(parsed)
        if text:
            chunks.append(text)
        if next_conversation_id:
            conversation_id = next_conversation_id

    merged_text = " ".join(part.strip() for part in chunks if part and part.strip())
    return merged_text, conversation_id


async def fetch_rag_answer(
    *,
    transcript: str,
    conversation_id: str,
    user_id: str,
) -> tuple[str, str | None]:
    if not RAG_API_KEY:
        raise RuntimeError("RAG_API_KEY is not configured")

    payload = {
        "inputs": {},
        "query": transcript,
        "response_mode": "streaming",
        "conversation_id": conversation_id,
        "user": user_id,
        "files": [],
    }

    headers = {
        "Authorization": f"Bearer {RAG_API_KEY}",
        "Content-Type": "application/json",
    }

    def _request() -> str:
        with requests.post(
            RAG_URL,
            headers=headers,
            json=payload,
            stream=True,
            timeout=(10, 120),
        ) as response:
            if response.status_code >= 400:
                raise RuntimeError(
                    f"RAG request failed with HTTP {response.status_code}: {response.text}"
                )
            return _parse_rag_response(response)

    return await asyncio.to_thread(_request)


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

    elevenlabs_api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    elevenlabs_voice_id = os.getenv("ELEVENLABS_VOICE_ID", "").strip()
    if elevenlabs_api_key and elevenlabs_voice_id:
        tts = ElevenLabsTTS(
            api_key=elevenlabs_api_key,
            voice_id=elevenlabs_voice_id,
            model_id=os.getenv("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
            language_code=os.getenv("ELEVENLABS_LANGUAGE_CODE", "vi").strip() or None,
            output_format=os.getenv("ELEVENLABS_OUTPUT_FORMAT", "pcm_16000"),
            voice_settings=_build_voice_settings(),
        )
        logger.info("Using ElevenLabs TTS voice_id=%s", elevenlabs_voice_id)
    else:
        logger.warning(
            "ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID is missing; falling back to OpenAI TTS"
        )
        tts = openai.TTS(
            model=os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
            voice=os.getenv("OPENAI_VOICE", "sage"),
            instructions=os.getenv(
                "OPENAI_TTS_INSTRUCTIONS",
                "Read the response in natural Vietnamese with clear pronunciation, "
                "a warm female voice, and moderate pace. Keep Vietnamese names and words natural.",
            ),
        )

    session = AgentSession(
        stt=openai.STT(language=os.getenv("STT_LANGUAGE", "vi"), detect_language=False),
        tts=tts,
        vad=silero.VAD.load(),
    )

    await avatar.start(session, room=ctx.room)

    rag_turn_lock = asyncio.Lock()

    async def handle_final_transcript(transcript: str, speaker_id: str | None) -> None:
        cleaned_transcript = transcript.strip()
        if not cleaned_transcript:
            return

        async with rag_turn_lock:
            room_key = ctx.room.name
            logger.info(
                "Sending transcript to RAG: room=%s speaker=%s text=%s",
                room_key,
                speaker_id or "unknown",
                cleaned_transcript,
            )

            await publish_turn_history(ctx.room, "user", cleaned_transcript)

            try:
                answer, next_conversation_id = await fetch_rag_answer(
                    transcript=cleaned_transcript,
                    conversation_id=RAG_CONVERSATIONS.get(room_key, ""),
                    user_id=speaker_id or f"{RAG_USER_PREFIX}-{room_key}",
                )
                if next_conversation_id:
                    RAG_CONVERSATIONS[room_key] = next_conversation_id
            except Exception:
                logger.exception("RAG request failed")
                await session.say(
                    "Sorry, I could not fetch an answer from the knowledge system.",
                    allow_interruptions=True,
                )
                return

            if not answer:
                answer = "I could not find a suitable answer for this question."

            logger.info("RAG raw answer received: %r", answer)
            await publish_turn_history(ctx.room, "assistant", answer)
            await session.say(answer, allow_interruptions=True)

    @session.on("user_input_transcribed")
    def on_user_input_transcribed(event: UserInputTranscribedEvent) -> None:
        if not event.is_final:
            return

        transcript = event.transcript.strip()
        if not transcript:
            return

        asyncio.create_task(handle_final_transcript(transcript, event.speaker_id))

    await session.start(
        agent=Agent(instructions=""),
        room=ctx.room,
        room_output_options=RoomOutputOptions(audio_enabled=False),
    )

if __name__ == "__main__":
    agent_name = os.getenv("LIVEKIT_AGENT_NAME", "").strip() or "bithuman-agent"
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name=agent_name,
            worker_type=WorkerType.ROOM,
            job_memory_warn_mb=1500,
            num_idle_processes=1,
        )
    )
