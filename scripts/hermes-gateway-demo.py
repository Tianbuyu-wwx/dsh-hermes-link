#!/usr/bin/env python3
"""
scripts/hermes-gateway-demo.py — Hermes-side gateway reference implementation
for the hermes-link v0.2.2 file protocols.

This is a *demonstration* of what the Hermes-side gateway/poller needs to do to
speak the v0.2.2 protocols. It is not a production gateway — Hermes-agent's
real gateway lives in the hermes-agent repo and is written in Python. Copy
this pattern (consult reply poller + amend file writer) into that codebase.

Two responsibilities covered here:

  1. CONSULT REPLY (D2, v0.2.2)
     - Poll `Hermes Home/inbox/dsh/consult/<ts>-<ticket>.json`
     - Read `payload.reply_secret` (16 hex chars)
     - For each file, invoke Hermes's reasoning model (or any LLM) to produce
       an answer
     - Write the reply to
       `Hermes Home/inbox/dsh/consult-reply/<ticket>-<secret>.json`
     - This file MUST use the secret suffix; legacy `<ticket>.json` is rejected
       by DSH unless env `HERMES_LINK_TRUST_LEGACY=1` is set.

  2. AMEND (H4, v0.2.2)
     - After dispatching a continuable task, DSH returns `metadata.amend_nonce`
       and `metadata.amend_filename_pattern` (e.g.
       "<ts>-<task_id>-<nonce>.json").
     - When the user / orchestrator decides to amend the running child,
       Hermes writes an amend file at the EXACT pattern DSH returned.
     - DSH verifies the nonce against its continuable_children registry before
       delivering; mismatched nonce → file moved to `done/bad-nonce-*.json`
       and never delivered.

Run as a stand-alone demo:

    python scripts/hermes-gateway-demo.py /path/to/hermes-home

It will:
  - Print what files it sees (it does NOT actually call an LLM; in a real
    gateway replace `_stub_consult_answer()` with your model call)
  - Drop synthetic reply + amend files that conform to the v0.2.2 protocol
  - Move processed consult files into `consult/done/` so you can re-run

Run with `--help` for option summary.

This script is dual-licensed MIT alongside the rest of dsh-hermes.
"""
from __future__ import annotations
import argparse
import json
import os
import secrets
import shutil
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# v0.2.2 protocol constants
# ---------------------------------------------------------------------------

CONSULT_DIR_NAME = "consult"
CONSULT_REPLY_DIR_NAME = "consult-reply"
AMEND_DIR_NAME = "amend"
DSH_INBOX_ROOT = "inbox/dsh"   # relative to Hermes Home


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def hermes_inbox(hermes_home: Path) -> Path:
    """`Hermes Home/inbox/dsh/`."""
    return hermes_home / "inbox" / "dsh"


def consult_dir(hermes_home: Path) -> Path:
    return hermes_inbox(hermes_home) / CONSULT_DIR_NAME


def consult_reply_dir(hermes_home: Path) -> Path:
    return hermes_inbox(hermes_home) / CONSULT_REPLY_DIR_NAME


def amend_dir(hermes_home: Path) -> Path:
    return hermes_inbox(hermes_home) / AMEND_DIR_NAME


def ts_for_filename(ts_ms: int) -> str:
    """Stable millisecond timestamp for filenames."""
    return str(ts_ms)


def parse_consult_filename(name: str) -> tuple[str, str] | None:
    """`<ts>-<ticket>.json` → (ts, ticket). Returns None on bad shape."""
    if not name.endswith(".json"):
        return None
    base = name[: -len(".json")]
    parts = base.split("-", 1)
    if len(parts) != 2 or not parts[0].isdigit() or not parts[1]:
        return None
    return parts[0], parts[1]


def parse_amend_filename(name: str) -> dict[str, str] | None:
    """
    v0.2.2+ :  `<ts>-<task_id>-<nonce>.json`
    v0.2.0/1 : `<ts>-<task_id>.json`   (REJECTED — never deliver)

    Returns {ts, task_id, nonce?, legacy?} or None on bad shape.
    """
    if not name.endswith(".json"):
        return None
    base = name[: -len(".json")]
    parts = base.split("-")
    if len(parts) < 3 or not parts[0].isdigit():
        return None
    head = {"ts": parts[0]}
    if len(parts) == 3:
        head["task_id"] = parts[1]
        head["nonce"] = parts[2]
        return head
    # task_id may itself contain hyphens; join everything except ts + nonce.
    head["task_id"] = "-".join(parts[1:-1])
    head["nonce"] = parts[-1]
    return head


def read_consult_payload(path: Path) -> dict[str, Any] | None:
    """Parse a consult inbox file and pull `ticket`, `reply_secret`, `prompt`."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    for k in ("ticket", "reply_secret", "prompt"):
        if not isinstance(data.get(k), str) or not data[k]:
            return None
    return data


def atomic_write_json(path: Path, obj: dict[str, Any]) -> None:
    """Atomic-ish write: tmp + rename. Reduces half-write risk for reply files."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def move_to_done(src: Path, dst_dir: Path, prefix: str = "") -> Path:
    """Move a file into <dst_dir>/ preserving its basename; add prefix if set."""
    dst_dir.mkdir(parents=True, exist_ok=True)
    target = dst_dir / (prefix + src.name) if prefix else dst_dir / src.name
    # Avoid name collisions
    if target.exists():
        target = dst_dir / (f"{prefix}{int(time.time() * 1000)}-{src.name}")
    shutil.move(str(src), str(target))
    return target


# ---------------------------------------------------------------------------
# Stubbed LLM call — replace with your model client
# ---------------------------------------------------------------------------


def _stub_consult_answer(prompt: str, ctx: dict[str, Any]) -> str:
    """
    Real Hermes gateway calls the reasoning model here. For this demo we just
    echo a deterministic answer so you can observe the file protocol end-to-end
    against a live DSH instance.
    """
    head = prompt[:80].replace("\n", " ")
    return f"[demo gateway reply to: {head}{'…' if len(prompt) > 80 else ''}]"


# ---------------------------------------------------------------------------
# Consult reply poller
# ---------------------------------------------------------------------------


def process_consult_once(hermes_home: Path) -> int:
    """Pick up pending consult files, reply via stub LLM, drop reply files.
    Returns count of files processed."""
    cd = consult_dir(hermes_home)
    rdir = consult_reply_dir(hermes_home)
    if not cd.exists():
        return 0
    rdir.mkdir(parents=True, exist_ok=True)
    done_dir = cd / "done"
    processed = 0
    for entry in sorted(cd.iterdir()):
        if entry.name in ("done",) or not entry.is_file():
            continue
        parsed = parse_consult_filename(entry.name)
        if not parsed:
            move_to_done(entry, done_dir, prefix="malformed-")
            continue
        ts, ticket = parsed
        payload = read_consult_payload(entry)
        if not payload:
            move_to_done(entry, done_dir, prefix="malformed-")
            continue
        # v0.2.2 — read the secret from the payload; if missing, this file
        # came from a pre-v0.2.2 Hermes. Treat as legacy (rejected unless
        # HERMES_LINK_TRUST_LEGACY=1).
        secret = payload.get("reply_secret")
        if not secret:
            legacy = os.environ.get("HERMES_LINK_TRUST_LEGACY") == "1"
            if not legacy:
                print(f"  [consult] {entry.name} has no reply_secret; "
                      "skipping (DSH will reject legacy reply files).")
                move_to_done(entry, done_dir, prefix="legacy-")
                continue
            suffix = ""  # legacy format: <ticket>.json
        else:
            suffix = f"-{secret}"

        # === stub LLM call ===
        answer = _stub_consult_answer(payload.get("prompt", ""), payload.get("context", {}) or {})
        # === drop reply ===
        reply_path = rdir / f"{ticket}{suffix}.json"
        atomic_write_json(reply_path, {
            "ticket": ticket,
            "answer": answer,
            "ts": int(time.time() * 1000),
            "source": "hermes-gateway-demo",
            "version": "hermes-link/0.2.2",
        })
        # === archive the consult request ===
        move_to_done(entry, done_dir)
        processed += 1
        print(f"  [consult] replied {entry.name} → {reply_path.name}")
    return processed


# ---------------------------------------------------------------------------
# Amend file writer (Hermes side: write the amend into the inbox)
# ---------------------------------------------------------------------------


def write_amend_file(
    hermes_home: Path,
    task_id: str,
    amend_nonce: str,
    content: list[dict[str, Any]] | None = None,
    text: str | None = None,
    note: str | None = None,
) -> Path:
    """
    Construct an amend file under v0.2.2 protocol.

    The filename MUST be `<ts>-<task_id>-<nonce>.json`. The body MUST be
    JSON with at least { task_id, content }.

    DSH will reject if nonce doesn't match the registered continuable child.
    """
    if not task_id or not amend_nonce:
        raise ValueError("task_id and amend_nonce are required")
    if not (isinstance(content, list) and content) and not text:
        raise ValueError("either content (ContentBlock[]) or text must be provided")
    body_content = content if (isinstance(content, list) and content) else [
        {"type": "text", "text": str(text or "")},
    ]
    ts_ms = int(time.time() * 1000)
    fname = f"{ts_ms}-{task_id}-{amend_nonce}.json"
    adir = amend_dir(hermes_home)
    adir.mkdir(parents=True, exist_ok=True)
    path = adir / fname
    atomic_write_json(path, {
        "task_id": task_id,
        "ts": ts_ms,
        "content": body_content,
        "note": note or "",
        "source": "hermes-gateway-demo",
        "version": "hermes-link/0.2.2",
    })
    print(f"  [amend] wrote {path}")
    return path


# ---------------------------------------------------------------------------
# Demo runner — picks up whatever is in the inbox and writes synthetic
# replies + a synthetic amend so the protocol can be observed end-to-end.
# ---------------------------------------------------------------------------


def demo_amend(hermes_home: Path) -> None:
    """Write one well-formed amend file. Uses a fake task_id + fake nonce —
    Hermes-side runtime would substitute the real nonce returned by dispatch_task."""
    fake_task = f"demo-{uuid.uuid4().hex[:8]}"
    fake_nonce = secrets.token_hex(16)
    print(f"  [demo-amend] writing with task_id={fake_task} nonce={fake_nonce}")
    print("    (DSH will mark this as 'unknown_task' / rejected_unknown_task after a "
          "minute — that's correct: nonce is valid syntax but no continuable child "
          "was registered for this task_id.)")
    write_amend_file(
        hermes_home,
        task_id=fake_task,
        amend_nonce=fake_nonce,
        text="Hello from the v0.2.2 demo gateway. DSH will (correctly) ignore this because no child is registered.",
        note="demo-amend-v0.2.2",
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Hermes-side gateway reference for hermes-link v0.2.2")
    ap.add_argument("hermes_home", help="Hermes Home directory (e.g. C:\\Users\\<you>\\AppData\\Local\\hermes)")
    ap.add_argument("--watch", action="store_true", help="Loop forever (poll every 2s) instead of one-shot")
    ap.add_argument("--demo-amend", action="store_true", help="Drop one synthetic amend file before polling")
    ap.add_argument("--interval", type=float, default=2.0, help="Poll interval seconds (default 2)")
    args = ap.parse_args()

    hermes_home = Path(args.hermes_home).resolve()
    if not hermes_home.exists():
        print(f"hermes_home does not exist: {hermes_home}", file=sys.stderr)
        return 2
    if not hermes_home.is_dir():
        print(f"hermes_home is not a directory: {hermes_home}", file=sys.stderr)
        return 2

    if args.demo_amend:
        print("=== writing one demo amend file ===")
        demo_amend(hermes_home)

    if args.watch:
        print(f"=== watching {hermes_home} every {args.interval}s (Ctrl-C to stop) ===")
        try:
            while True:
                processed = process_consult_once(hermes_home)
                if processed:
                    print(f"  processed {processed} consult request(s)")
                time.sleep(args.interval)
        except KeyboardInterrupt:
            print("\nstopped.")
    else:
        print("=== one-shot pass ===")
        processed = process_consult_once(hermes_home)
        print(f"  total processed: {processed}")

    return 0


if __name__ == "__main__":
    sys.exit(main())