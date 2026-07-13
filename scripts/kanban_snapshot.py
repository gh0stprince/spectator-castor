#!/usr/bin/env python3
"""Emit a safe, read-only active Kanban snapshot for Spectator."""
import json
import os
import sqlite3

DB = os.path.join(os.environ["LOCALAPPDATA"], "hermes", "kanban", "boards", "code-tasks", "kanban.db")


def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, title, status, assignee, priority, created_at, completed_at "
            "FROM tasks WHERE status != 'archived'"
        ).fetchall()
        tasks = {row["id"]: {
            "id": row["id"], "title": row["title"], "status": row["status"],
            "assignee": row["assignee"] or "unassigned", "priority": row["priority"] or 0,
            "completed_at": row["completed_at"] or 0,
        } for row in rows}
        links = [dict(row) for row in conn.execute("SELECT parent_id, child_id FROM task_links")]
    finally:
        conn.close()

    # Follow the live frontier backwards and forwards. This keeps the route
    # focused on work currently in motion instead of exposing the whole board.
    active = {task_id for task_id, task in tasks.items() if task["status"] == "running"}
    if not active:
        candidates = {task_id for task_id, task in tasks.items() if task["status"] in {"ready", "review"}}
        if not candidates:
            salon = {task_id for task_id, task in tasks.items() if task["status"] not in {"archived", "done"} and "research salon" in task["title"].lower()}
            candidates = salon or {task_id for task_id, task in tasks.items() if task["status"] not in {"archived", "done"}}
        active = candidates
    changed = True
    while changed:
        changed = False
        for link in links:
            if link["child_id"] in active and link["parent_id"] in tasks and link["parent_id"] not in active:
                active.add(link["parent_id"]); changed = True
            if link["parent_id"] in active and link["child_id"] in tasks and link["child_id"] not in active:
                active.add(link["child_id"]); changed = True

    route_tasks = [tasks[task_id] for task_id in active]
    route_tasks.sort(key=lambda task: (task["completed_at"] == 0, task["priority"], task["title"]))
    route_ids = {task["id"] for task in route_tasks}
    route_links = [link for link in links if link["parent_id"] in route_ids and link["child_id"] in route_ids]
    print(json.dumps({"board": "code-tasks", "tasks": route_tasks, "links": route_links}, separators=(",", ":")))


if __name__ == "__main__":
    main()
