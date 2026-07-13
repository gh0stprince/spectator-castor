#!/usr/bin/env python3
"""Auto-push Hermes session messages and subagent metadata to Spectator."""
import json
import os
import random
import signal
import sqlite3
import sys
import time

import requests


SPECTATOR_URL = "http://localhost:8787"
POLL_INTERVAL = 1.0
SUBAGENT_HEARTBEAT_SECONDS = 5
SUBAGENT_LIMIT = 3
DB = os.path.join(os.environ["LOCALAPPDATA"], "hermes", "state.db")


class SessionWatcher:
    """Push one CLI session and lightweight metadata about its peer sessions.

    The watcher deliberately reads only already-local SQLite state. It does not
    call the gateway, inspect tool arguments, or reveal full session history.
    """

    def __init__(self, db=DB, session_source="cli", post=requests.post, now=time.time):
        self.db = db
        self.session_source = session_source
        self.post = post
        self.now = now
        self.sent_ids = {}
        self.last_session_id = None
        self.last_subagent_heartbeat = None

    def push(self, kind, payload, actor_type="agent", actor_name="Castor", session_id="live"):
        timestamp = int(self.now() * 1000)
        event = {
            "id": f"{timestamp}-{random.randint(0, 9999)}",
            "ts": timestamp,
            "sessionId": session_id,
            "seq": 0,
            "actor": {
                "type": actor_type,
                "id": "agent" if actor_type == "agent" else "operator",
                "name": actor_name,
            },
            "kind": kind,
            "payload": payload,
        }
        try:
            response = self.post(f"{SPECTATOR_URL}/ingest", json=event, timeout=2)
            return bool(getattr(response, "ok", True))
        except Exception:
            return False

    def _rows(self, query, params=()):
        conn = sqlite3.connect(self.db)
        try:
            conn.row_factory = sqlite3.Row
            return [dict(row) for row in conn.execute(query, params)]
        finally:
            conn.close()

    def get_current_session(self):
        """Return the newest watched-source session, preferring an open one."""
        rows = self._rows(
            "SELECT id, title, model, started_at FROM sessions "
            "WHERE source = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
            (self.session_source,),
        )
        if rows:
            return rows[0]
        rows = self._rows(
            "SELECT id, title, model, started_at FROM sessions "
            "WHERE source = ? ORDER BY started_at DESC LIMIT 1",
            (self.session_source,),
        )
        return rows[0] if rows else None

    @staticmethod
    def _subagent_status(last_activity, now):
        age = max(0, now - (last_activity or now))
        if age <= 10:
            return "running"
        if age <= 45:
            return "waiting"
        return "idle"

    def detect_subagents(self):
        """Return up to three open non-self sessions with safe display metadata."""
        sessions = self._rows(
            "SELECT id, source, title, model, started_at FROM sessions "
            "WHERE ended_at IS NULL AND id != ? ORDER BY started_at DESC LIMIT ?",
            (self.last_session_id or "", SUBAGENT_LIMIT),
        )
        now = self.now()
        agents = []
        for session in sessions:
            activity = self._rows(
                "SELECT timestamp FROM messages WHERE session_id = ? "
                "ORDER BY timestamp DESC LIMIT 1",
                (session["id"],),
            )
            started_at = session.get("started_at") or now
            task = (session.get("title") or "untitled task").strip()
            agents.append({
                "name": session.get("model") or session.get("source") or "Hermes",
                "task": task[:50],
                "elapsed_s": max(0, int(now - started_at)),
                "status": self._subagent_status(activity[0]["timestamp"] if activity else None, now),
            })
        return agents

    def poll_subagents(self):
        agents = self.detect_subagents()
        if not agents:
            self.last_subagent_heartbeat = None
            return
        now = self.now()
        if self.last_subagent_heartbeat is None or now - self.last_subagent_heartbeat >= SUBAGENT_HEARTBEAT_SECONDS:
            if self.push("subagent.meta", {"agents": agents}, session_id=self.last_session_id or "live"):
                self.last_subagent_heartbeat = now

    def poll(self):
        session = self.get_current_session()
        if not session:
            return

        sid = session["id"]
        title = session.get("title") or sid
        if sid != self.last_session_id:
            print(f"[watcher] session: {sid} ({title})", flush=True)
            if not self.push("session.meta", {"title": title, "model": session.get("model") or "unknown", "startedAt": int(self.now() * 1000)}, session_id=sid):
                return
            # Do not backfill history. Establish a high-water mark from the
            # rows that already exist when we begin watching this session; only
            # messages inserted after this point are live stream events.
            existing = self._rows("SELECT id FROM messages WHERE session_id = ?", (sid,))
            self.sent_ids[sid] = {row["id"] for row in existing}
            self.last_session_id = sid

        seen = self.sent_ids.setdefault(sid, set())
        rows = self._rows("SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC", (sid,))
        for row in rows:
            mid = row["id"]
            if mid in seen:
                continue
            if not self._push_message(sid, row):
                break
            seen.add(mid)
        self.poll_subagents()

    def _push_message(self, sid, row):
        mid = row["id"]
        role = row["role"]
        content = row.get("content") or ""
        tool_calls = row.get("tool_calls")
        tool_name = row.get("tool_name") or "tool"
        if role == "user":
            return self.push("user.message", {"text": content[:500]}, "human", "Da", sid)
        if role == "tool" and content:
            return self.push("tool.progress", {"toolId": f"t-{mid}", "chunk": content[:400]}, session_id=sid)
        if role != "assistant":
            return True

        events = []
        if tool_calls:
            try:
                calls = json.loads(tool_calls) if isinstance(tool_calls, str) else tool_calls
                for call in calls if isinstance(calls, list) else [calls]:
                    function = call.get("function", call)
                    name = function.get("name", tool_name)
                    events.append(("tool.start", {"toolId": f"t-{mid}", "name": name, "summary": name}))
            except Exception:
                events.append(("tool.start", {"toolId": f"t-{mid}", "name": tool_name, "summary": tool_name}))
        if content:
            events.extend([
                ("status", {"state": "thinking"}),
                ("message.delta", {"messageId": f"m-{mid}", "text": content[:300]}),
                ("message.complete", {"messageId": f"m-{mid}", "text": content[:500]}),
            ])
        if tool_calls:
            events.append(("tool.complete", {"toolId": f"t-{mid}", "status": "ok", "summary": f"{tool_name} done"}))
        events.append(("status", {"state": "idle"}))
        return all(self.push(kind, payload, session_id=sid) for kind, payload in events)


def main():
    watcher = SessionWatcher()
    signal.signal(signal.SIGTERM, lambda *_args: sys.exit(0))
    print(f"[watcher] DB: {watcher.db}", flush=True)
    print(f"[watcher] Spectator: {SPECTATOR_URL}", flush=True)
    while True:
        watcher.poll()
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
