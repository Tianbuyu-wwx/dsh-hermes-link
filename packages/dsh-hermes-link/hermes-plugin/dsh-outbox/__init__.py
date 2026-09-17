"""dsh-bridge - the Hermes half of the dsh-hermes-link reverse channel.

WHY THIS EXISTS
    docs/DSH-HERMES-LINK-PLAN.md promised `Hermes Home/outbox/hermes/` ("Hermes 给 DSH 的
    主动通知") from the start; the DSH consumer shipped in dsh-hermes-link v0.6.0 and has
    been verified live, but nothing on the Hermes side ever wrote a file, so the channel
    was a consumer with no producer. This plugin is that producer.

WHAT IT DOES
    `on_session_end` fires once per Hermes TURN (agent/turn_finalizer.py) with
    `session_id`, `task_id`, `turn_id`, `completed`, `failed`, `interrupted`,
    `turn_exit_reason`, `model`, `platform`. Every turn end drops one notification
    telling DSH to (re)import that session; a failed/interrupted turn also drops a
    `notify` so DSH's SSE channel carries the failure. `/dsh-notify <message>` lets a
    human push a message through the same channel.

CONTRACT (implemented by services/hermes-outbox-consumer.mjs on the DSH side)
    <Hermes Home>/outbox/hermes/<ts>-<rand>.json
    { "id": "<unique>", "source": "hermes", "kind": "import" | "notify" | "ping",
      "session_id"?: "...", "created_at": <ms>, "payload"?: {...} }
    - written atomically (tmp + os.replace) as bare UTF-8 (never a BOM: JSON.parse
      refuses one, and that exact trap already cost this project a debugging round)
    - `id` is the idempotency key; a redelivered file is archived, never re-executed
    - the consumer archives every file into outbox/hermes/done/ with an outcome prefix

SAFETY
    Every entry point is wrapped: a broken producer must never take a Hermes turn down.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

PLUGIN_VERSION = "0.1.0"
PRODUCER = "dsh-bridge"


def _hermes_home() -> Path:
    """Same precedence the DSH side uses (detectHermesHome in index.mjs)."""
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env)
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "hermes"
    return Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "hermes"


def outbox_dir() -> Path:
    return _hermes_home() / "outbox" / "hermes"


def write_notification(kind: str, *, session_id: Optional[str] = None,
                       payload: Optional[dict] = None, unique: Optional[str] = None) -> Optional[str]:
    """Drop one notification. Returns its path, or None when it could not be written.

    Best-effort by contract: this runs inside a Hermes turn, so it must never raise.
    """
    try:
        directory = outbox_dir()
        directory.mkdir(parents=True, exist_ok=True)
        now_ms = int(time.time() * 1000)
        stamp = unique or str(now_ms)
        doc: dict = {
            "id": "%s:%s:%s" % (kind, session_id or "session", stamp),
            "source": "hermes",
            "kind": kind,
            "created_at": now_ms,
            "producer": "%s/%s" % (PRODUCER, PLUGIN_VERSION),
        }
        if session_id:
            doc["session_id"] = str(session_id)
        if payload:
            doc["payload"] = payload
        name = "%d-%s.json" % (now_ms, uuid.uuid4().hex[:8])
        tmp = directory / (name + ".tmp")
        final = directory / name
        # encode() writes bare UTF-8 by construction: no BOM, which is the whole point.
        tmp.write_bytes(json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8"))
        os.replace(tmp, final)
        logger.debug("dsh-bridge: wrote %s", final)
        return str(final)
    except Exception as exc:  # noqa: BLE001 - a producer must never break a turn
        logger.warning("dsh-bridge: could not write a %s notification: %s", kind, exc)
        return None


def _on_session_end(session_id: str = "", task_id: str = "", turn_id: Any = None,
                    completed: bool = False, failed: bool = False, interrupted: bool = False,
                    turn_exit_reason: str = "", model: str = "", platform: str = "",
                    **_: Any) -> None:
    """One Hermes turn ended -> ask DSH to (re)import the session right now."""
    if not session_id:
        return
    payload = {
        "event": "turn_end",
        "turn_id": turn_id,
        "completed": bool(completed),
        "failed": bool(failed),
        "interrupted": bool(interrupted),
        "turn_exit_reason": turn_exit_reason or None,
        "model": model or None,
        "platform": platform or None,
        "task_id": task_id or None,
    }
    stamp = "turn:%s" % (turn_id if turn_id is not None else int(time.time() * 1000))
    if failed or interrupted:
        # Surface the failure on DSH's SSE channel as well; the import below keeps
        # DSH's copy of the session fresh either way.
        write_notification("notify", session_id=session_id, payload=payload, unique=stamp)
    write_notification("import", session_id=session_id, payload=payload, unique=stamp)


def _handle_slash(raw_args: str) -> str:
    """/dsh-notify <message> - push a message to the local DSH instance."""
    text = (raw_args or "").strip()
    if not text or text in {"help", "-h", "--help"}:
        return ("usage: /dsh-notify <message>\n"
                "Drops one notify notification into %s; the local DSH (dsh-hermes-link) "
                "instance consumes it on its next scan." % outbox_dir())
    path = write_notification("notify", payload={"event": "message", "message": text},
                              unique=uuid.uuid4().hex[:8])
    if path:
        return "sent to DSH: %s" % path
    return "could not write the notification - see the Hermes log (outbox dir: %s)" % outbox_dir()


def register(ctx) -> None:  # noqa: ANN001 - Hermes plugin context
    """Hermes plugin entry point."""
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_command("dsh-notify", handler=_handle_slash,
                         description="Send a notification to the local DeepSeek Harness (dsh-hermes-link).",
                         args_hint="<message>")
    # A producer-ready ping so DSH can tell "no notifications" from "no producer".
    write_notification("notify", payload={
        "event": "producer_ready",
        "version": PLUGIN_VERSION,
        "home": str(_hermes_home()),
        "platform": sys.platform,
    }, unique="boot:%d" % int(time.time() * 1000))
