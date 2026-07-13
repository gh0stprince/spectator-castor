import importlib.util
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path


WATCHER_PATH = Path(__file__).resolve().parents[1] / "session-watcher.py"
spec = importlib.util.spec_from_file_location("session_watcher", WATCHER_PATH)
watcher_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watcher_module)


class Response:
    def __init__(self, ok=True):
        self.ok = ok


class SessionWatcherTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tempdir.name) / "state.db")
        with closing(sqlite3.connect(self.db)) as conn:
            conn.executescript(
                """
                CREATE TABLE sessions (
                  id TEXT PRIMARY KEY, source TEXT, title TEXT, model TEXT,
                  started_at REAL, ended_at REAL
                );
                CREATE TABLE messages (
                  id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,
                  content TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL
                );
                """
            )
            conn.commit()

    def tearDown(self):
        self.tempdir.cleanup()

    def test_retries_failed_delivery_and_tracks_cli_session_switches_without_sqlite_parameter_limit(self):
        with closing(sqlite3.connect(self.db)) as conn:
            conn.executemany(
                "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)",
                [
                    ("cli-old", "cli", "Old CLI", "model-a", 1, None),
                    ("api-new", "api_server", "Ignore me", "model-x", 3, None),
                    ("cli-new", "cli", "New CLI", "model-b", 2, None),
                ],
            )
            conn.executemany(
                "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)",
                [(index, "cli-new", "user", f"message {index}", None, None, index) for index in range(1, 1002)],
            )
            conn.commit()

        events = []
        attempts = 0

        def post(_url, *, json, timeout):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return Response(False)
            events.append(json)
            return Response(True)

        watcher = watcher_module.SessionWatcher(db=self.db, session_source="cli", post=post)
        watcher.poll()
        self.assertEqual(events, [])
        self.assertEqual(watcher.sent_ids, {})

        watcher.poll()
        self.assertEqual(events[0]["kind"], "session.meta")
        self.assertEqual(events[0]["sessionId"], "cli-new")
        self.assertEqual(sum(event["kind"] == "user.message" for event in events), 0)

        with closing(sqlite3.connect(self.db)) as conn:
            conn.execute(
                "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)",
                (2000, "cli-new", "user", "live message", None, None, 2000),
            )
            conn.commit()
        watcher.poll()
        self.assertEqual(sum(event["kind"] == "user.message" for event in events), 1)

        with closing(sqlite3.connect(self.db)) as conn:
            conn.execute("UPDATE sessions SET ended_at = 4 WHERE id = 'cli-new'")
            conn.commit()
        watcher.poll()
        metadata = [event for event in events if event["kind"] == "session.meta"]
        self.assertEqual([event["sessionId"] for event in metadata], ["cli-new", "cli-old"])
        self.assertNotIn("api-new", [event["sessionId"] for event in events])

    def test_detect_subagents_excludes_watched_session_limits_rows_and_emits_every_five_seconds(self):
        with closing(sqlite3.connect(self.db)) as conn:
            conn.executemany(
                "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)",
                [
                    ("self", "cli", "Watched session", "model-self", 100, None),
                    ("active", "cli", "Build the telemetry panel " + "x" * 80, "model-a", 90, None),
                    ("waiting", "cli", "Wait for operator", "model-b", 80, None),
                    ("idle", "cli", "Finished task", "model-c", 70, None),
                    ("fourth", "cli", "Do not include", "model-d", 60, None),
                ],
            )
            conn.executemany(
                "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                    (1, "active", "assistant", "working", None, None, 198),
                    (2, "waiting", "assistant", "need input", None, None, 180),
                    (3, "idle", "assistant", "done", None, None, 100),
                ],
            )
            conn.commit()

        events = []
        now = [200]
        watcher = watcher_module.SessionWatcher(
            db=self.db,
            session_source="cli",
            post=lambda _url, *, json, timeout: events.append(json) or Response(),
            now=lambda: now[0],
        )
        watcher.last_session_id = "self"

        watcher.poll_subagents()
        watcher.poll_subagents()
        now[0] += 5
        watcher.poll_subagents()

        metadata = [event for event in events if event["kind"] == "subagent.meta"]
        self.assertEqual(len(metadata), 2)
        self.assertEqual([agent["name"] for agent in metadata[0]["payload"]["agents"]], ["model-a", "model-b", "model-c"])
        self.assertNotIn("self", [agent["name"] for agent in metadata[0]["payload"]["agents"]])
        self.assertLessEqual(len(metadata[0]["payload"]["agents"][0]["task"]), 50)
        self.assertEqual(metadata[0]["payload"]["agents"][0]["status"], "running")
        self.assertEqual(metadata[0]["payload"]["agents"][1]["status"], "waiting")
        self.assertEqual(metadata[0]["payload"]["agents"][2]["status"], "idle")


if __name__ == "__main__":
    unittest.main()
