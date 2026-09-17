"""dsh-link - the Hermes half of the dsh-hermes-link bridge (both directions).

WHY THIS EXISTS
    The DSH side advertises two Hermes-facing channels that need a counterpart here:
      * `Hermes Home/outbox/hermes/` ("Hermes 给 DSH 的主动通知", promised in
        docs/DSH-HERMES-LINK-PLAN.md) -- the DSH consumer shipped in v0.6.0 and had
        nothing to consume until this plugin produced files.
      * `Hermes Home/inbox/dsh/consult/` -- `consult_hermes` has been writing tickets
        there since v0.2.0 and NOTHING on the Hermes side ever answered one (the audit
        found three tickets that had been sitting for three weeks).
    A consumer with no producer, and a question with no answerer, both look exactly
    like "nothing to do". This plugin is the missing half of both.

WHAT IT DOES
    1. OUTBOX (Hermes -> DSH)
       `on_session_end` fires once per Hermes TURN (agent/turn_finalizer.py) with
       session_id / task_id / turn_id / completed / failed / interrupted /
       turn_exit_reason / model / platform. Every turn end drops one `import`
       notification (DSH imports or refreshes that session immediately); a failed or
       interrupted turn also drops a `notify`. `/dsh-notify <message>` pushes a
       human-written message through the same channel.
    2. CONSULT (DSH -> Hermes -> DSH)
       A background thread watches `inbox/dsh/consult/`; each pending ticket is
       answered with `ctx.llm.complete(...)` (the host-owned facade: the user's active
       model, no API keys in the plugin) and the reply is written where the DSH client
       expects it: `consult-reply/<ticket>-<secret>.json`, with the secret taken from
       the ticket (v0.2.2 requires that suffix). An `<ticket>.answered.json` marker
       stays behind so the DSH side can tell "answered" from "abandoned" even after the
       reply file is consumed. `/dsh-consult` drains the queue on demand.
       Knobs (config.yaml → plugins.entries.dsh-link.consult.*): enabled (default
       true), interval_seconds (15), ttl_hours (24), max_tokens (1024), max_per_cycle (2),
       system_prompt.

CONTRACT (the DSH side implements the other end)
    outbox/hermes/<ts>-<rand>.json
    { "id", "source": "hermes", "kind": "import" | "notify" | "ping", "session_id"?, "created_at", "payload"? }
    consult-reply/<ticket>-<secret>.json
    { "ticket", "answer", "ts", "source": "hermes", "model", "usage" }
    Written atomically (tmp + os.replace) as bare UTF-8: a BOM makes JSON.parse refuse
    the file, and that exact trap already cost this project a debugging round.

SAFETY
    Every entry point is wrapped: a broken bridge must never take a Hermes turn down.
    Tickets older than ttl_hours are left alone (DSH's own TTL sweep marks those).
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

PLUGIN_VERSION = "0.2.0"
PLUGIN_NAME = "dsh-link"
PRODUCER = PLUGIN_NAME

DEFAULTS = {
    "enabled": True,
    "interval_seconds": 15,
    "ttl_hours": 24,
    "max_tokens": 1024,
    "max_per_cycle": 2,
    "timeout_seconds": 120,
    "system_prompt": (
        "You are Hermes, answering a consult ticket written by a DeepSeek Harness (DSH) coding "
        "agent that is blocked on your judgement. Answer the question directly and concretely, "
        "state any assumption you make, and keep it short: the caller is waiting synchronously."
    ),
}


# ---------------------------------------------------------------------------
# paths
# ---------------------------------------------------------------------------

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


def consult_inbox_dir() -> Path:
    return _hermes_home() / "inbox" / "dsh" / "consult"


def consult_reply_dir() -> Path:
    return _hermes_home() / "inbox" / "dsh" / "consult-reply"


def _atomic_write(path: Path, doc: dict) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    # encode() is bare UTF-8 by construction: no BOM, which is the whole point.
    tmp.write_bytes(json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8"))
    os.replace(tmp, path)
    return str(path)


def _read_json(path: Path) -> Optional[dict]:
    try:
        text = path.read_text(encoding="utf-8-sig")   # tolerate a BOM from other writers
        doc = json.loads(text)
        return doc if isinstance(doc, dict) else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# direction 1: Hermes -> DSH notifications
# ---------------------------------------------------------------------------

def write_notification(kind: str, *, session_id: Optional[str] = None,
                       payload: Optional[dict] = None, unique: Optional[str] = None) -> Optional[str]:
    """Drop one notification. Returns its path, or None when it could not be written."""
    try:
        now_ms = int(time.time() * 1000)
        doc: dict = {
            "id": "%s:%s:%s" % (kind, session_id or "session", unique or str(now_ms)),
            "source": "hermes",
            "kind": kind,
            "created_at": now_ms,
            "producer": "%s/%s" % (PRODUCER, PLUGIN_VERSION),
        }
        if session_id:
            doc["session_id"] = str(session_id)
        if payload:
            doc["payload"] = payload
        return _atomic_write(outbox_dir() / ("%d-%s.json" % (now_ms, uuid.uuid4().hex[:8])), doc)
    except Exception as exc:  # noqa: BLE001 - a producer must never break a turn
        logger.warning("%s: could not write a %s notification: %s", PLUGIN_NAME, kind, exc)
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
        write_notification("notify", session_id=session_id, payload=payload, unique=stamp)
    write_notification("import", session_id=session_id, payload=payload, unique=stamp)


# ---------------------------------------------------------------------------
# direction 2: DSH consult tickets -> answers
# ---------------------------------------------------------------------------

def _consult_config(ctx) -> dict:  # noqa: ANN001
    cfg = dict(DEFAULTS)
    for key, fallback in DEFAULTS.items():
        try:
            value = ctx.get_config("consult.%s" % key, fallback)
        except Exception:
            value = fallback
        if isinstance(fallback, bool):
            cfg[key] = bool(value)
        elif isinstance(fallback, int) and not isinstance(fallback, bool):
            try:
                cfg[key] = int(value)
            except Exception:
                cfg[key] = fallback
        else:
            cfg[key] = value or fallback
    return cfg


def _pending_tickets(ttl_hours: float, now: Optional[float] = None) -> list:
    """Tickets that are worth answering: not answered, not expired, not too old."""
    now = now or time.time()
    directory = consult_inbox_dir()
    try:
        entries = sorted(directory.glob("*.json"))
    except Exception:
        return []
    pending = []
    reply_dir = consult_reply_dir()
    for path in entries:
        name = path.name
        if name.endswith(".expired.json") or name.endswith(".answered.json"):
            continue
        doc = _read_json(path)
        if not doc:
            continue
        ticket = str(doc.get("ticket") or "").strip()
        if not ticket:
            continue
        # Already answered? A reply file may have been consumed by DSH, so the
        # marker is the durable evidence.
        if (directory / ("%s.answered.json" % ticket)).exists():
            continue
        try:
            if any(reply_dir.glob("%s-*.json" % ticket)) or (reply_dir / ("%s.json" % ticket)).exists():
                continue
        except Exception:
            pass
        age_hours = (now - float(doc.get("ts") or 0) / 1000.0) / 3600.0 if doc.get("ts") else None
        if age_hours is not None and age_hours > ttl_hours:
            continue   # DSH's own TTL sweep owns these; do not spend tokens on them
        pending.append({"path": path, "doc": doc, "ticket": ticket, "age_hours": age_hours})
    return pending


def answer_ticket(ctx, ticket: dict, cfg: dict) -> Optional[str]:  # noqa: ANN001
    """Answer one consult ticket with the host-owned LLM facade and write the reply."""
    doc = ticket["doc"]
    reply_dir = consult_reply_dir()
    ticket_id = ticket["ticket"]
    secret = str(doc.get("reply_secret") or "").strip()
    prompt = str(doc.get("prompt") or "").strip()
    if not prompt:
        return None
    messages = [{"role": "system", "content": str(cfg.get("system_prompt") or DEFAULTS["system_prompt"])}]
    context = doc.get("context")
    user_text = prompt
    if context:
        try:
            user_text += "\n\n[context]\n" + json.dumps(context, ensure_ascii=False)[:4000]
        except Exception:
            pass
    messages.append({"role": "user", "content": user_text})

    started = time.time()
    result = ctx.llm.complete(messages, max_tokens=int(cfg.get("max_tokens") or 1024),
                              timeout=float(cfg.get("timeout_seconds") or 120),
                              purpose="dsh-consult")
    answer = (getattr(result, "text", "") or "").strip()
    if not answer:
        raise RuntimeError("the model returned an empty answer")

    usage = getattr(result, "usage", None)
    reply = {
        "ticket": ticket_id,
        "answer": answer,
        "ts": int(time.time() * 1000),
        "source": "hermes",
        "kind": "consult-reply",
        "model": getattr(result, "model", None),
        "provider": getattr(result, "provider", None),
        "elapsed_ms": int((time.time() - started) * 1000),
        "usage": {
            "input_tokens": getattr(usage, "input_tokens", 0),
            "output_tokens": getattr(usage, "output_tokens", 0),
            "total_tokens": getattr(usage, "total_tokens", 0),
        } if usage is not None else None,
    }
    # v0.2.2 requires the secret suffix; without one DSH only accepts legacy names
    # when HERMES_LINK_TRUST_LEGACY=1, so say so loudly instead of answering silently.
    target = reply_dir / (("%s-%s.json" % (ticket_id, secret)) if secret else ("%s.json" % ticket_id))
    written = _atomic_write(target, reply)
    if not secret:
        logger.warning("%s: ticket %s carries no reply_secret; wrote the legacy reply name %s",
                       PLUGIN_NAME, ticket_id, target.name)
    try:
        _atomic_write(consult_inbox_dir() / ("%s.answered.json" % ticket_id), {
            "ticket": ticket_id,
            "ts": int(time.time() * 1000),
            "source": "hermes",
            "kind": "consult-answered",
            "ticket_file": ticket["path"].name,
            "reply_file": target.name,
            "model": reply.get("model"),
            "note": "answered by the dsh-link plugin; kept so DSH can tell answered from abandoned",
        })
    except Exception as exc:  # noqa: BLE001
        logger.warning("%s: could not write the answered marker for %s: %s", PLUGIN_NAME, ticket_id, exc)
    logger.info("%s: answered consult %s (%d chars) -> %s", PLUGIN_NAME, ticket_id, len(answer), target.name)
    return written


def drain_consult_queue(ctx, cfg: Optional[dict] = None, limit: Optional[int] = None) -> dict:  # noqa: ANN001
    """Answer up to `limit` pending tickets. Never raises; returns a small report."""
    cfg = cfg or _consult_config(ctx)
    report = {"pending": 0, "answered": 0, "failed": 0, "errors": []}
    if not cfg.get("enabled", True):
        return report
    pending = _pending_tickets(float(cfg.get("ttl_hours") or 24))
    report["pending"] = len(pending)
    cap = limit if isinstance(limit, int) and limit > 0 else int(cfg.get("max_per_cycle") or 2)
    for ticket in pending[:cap]:
        try:
            if answer_ticket(ctx, ticket, cfg):
                report["answered"] += 1
        except Exception as exc:  # noqa: BLE001 - one bad ticket must not stop the rest
            report["failed"] += 1
            report["errors"].append("%s: %s" % (ticket["ticket"], exc))
            logger.warning("%s: consult %s could not be answered: %s", PLUGIN_NAME, ticket["ticket"], exc)
    return report


class _ConsultPoller:
    """Cheap file polling on a daemon thread; the LLM call only happens on a ticket."""

    def __init__(self, ctx, config: dict) -> None:  # noqa: ANN001
        self._ctx = ctx
        self._config = config
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.last_report: dict = {"pending": 0, "answered": 0, "failed": 0, "errors": []}

    def start(self) -> None:
        if not self._config.get("enabled", True):
            logger.info("%s: consult poller disabled by config", PLUGIN_NAME)
            return
        self._thread = threading.Thread(target=self._run, name="dsh-link-consult", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        interval = max(5, int(self._config.get("interval_seconds") or 15))
        while not self._stop.wait(1.0):
            try:
                report = drain_consult_queue(self._ctx, self._config)
                self.last_report = report
                if report["answered"] or report["failed"]:
                    time.sleep(interval)   # back off between batches
            except Exception as exc:  # noqa: BLE001 - the poller must never die loudly
                logger.warning("%s: consult poll failed: %s", PLUGIN_NAME, exc)
                self._stop.wait(interval)

    def stop(self) -> None:
        self._stop.set()


# ---------------------------------------------------------------------------
# slash commands
# ---------------------------------------------------------------------------

def _handle_notify(raw_args: str) -> str:
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


def _handle_consult(raw_args: str, ctx=None) -> str:  # noqa: ANN001
    """/dsh-consult [n] - answer pending DSH consult tickets now."""
    if ctx is None:
        return "consult draining needs the plugin context (unavailable here)"
    arg = (raw_args or "").strip()
    limit = None
    if arg.isdigit():
        limit = max(1, min(10, int(arg)))
    try:
        report = drain_consult_queue(ctx, _consult_config(ctx), limit=limit or 10)
    except Exception as exc:  # noqa: BLE001
        return "consult drain failed: %s" % exc
    if report["pending"] == 0:
        return "no pending consult tickets in %s" % consult_inbox_dir()
    lines = ["pending: %d, answered: %d, failed: %d" % (report["pending"], report["answered"], report["failed"])]
    lines.extend("  ! " + e for e in report["errors"][:5])
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# plugin entry point
# ---------------------------------------------------------------------------

def register(ctx) -> None:  # noqa: ANN001 - Hermes plugin context
    """Hermes plugin entry point."""
    ctx.register_hook("on_session_end", _on_session_end)

    ctx.register_command("dsh-notify", handler=_handle_notify,
                         description="Send a notification to the local DeepSeek Harness (dsh-hermes-link).",
                         args_hint="<message>")
    ctx.register_command("dsh-consult", handler=lambda raw: _handle_consult(raw, ctx),
                         description="Answer pending DSH consult tickets with this Hermes model.",
                         args_hint="[count]")

    config = _consult_config(ctx)
    poller = _ConsultPoller(ctx, config)
    try:
        ctx.on_unload(poller.stop)
    except Exception:
        pass
    poller.start()

    # A producer-ready ping so DSH can tell "no notifications" from "no producer".
    write_notification("notify", payload={
        "event": "producer_ready",
        "version": PLUGIN_VERSION,
        "home": str(_hermes_home()),
        "platform": sys.platform,
        "consult_enabled": bool(config.get("enabled", True)),
    }, unique="boot:%d" % int(time.time() * 1000))
