"""SQLite リポジトリ実装.

domain/guide/repositories.py の FeedbackRepository を実装。
"""

import logging
import sqlite3
import uuid
from pathlib import Path

from src.config import settings
from src.domain.guide.model import FailedPlan, Feedback

logger = logging.getLogger(__name__)

DB_PATH = Path(settings.static_dir).parent / "db" / "guidey_user.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    settings_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT NOT NULL,
    preference_type TEXT NOT NULL,
    preference_value TEXT NOT NULL,
    confidence REAL DEFAULT 0.5,
    source TEXT DEFAULT 'explicit',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, preference_type),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS user_sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    task_description TEXT,
    domain TEXT,
    completed BOOLEAN DEFAULT FALSE,
    plan_json TEXT,
    used_chunk_ids TEXT,
    user_satisfaction INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS feedback (
    feedback_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'default',
    session_id TEXT,
    target_type TEXT NOT NULL,
    target_id TEXT,
    target_content TEXT,
    sentiment TEXT NOT NULL,
    source TEXT NOT NULL,
    raw_content TEXT,
    rag_chunks_used TEXT,
    step_index INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_target ON feedback(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_feedback_sentiment ON feedback(sentiment);

CREATE TABLE IF NOT EXISTS user_mistakes (
    mistake_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_id TEXT,
    domain TEXT,
    description TEXT,
    step_context TEXT,
    severity INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS failed_plans (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'default',
    plan_source_id TEXT,
    task_description TEXT,
    abandoned_at_step INTEGER,
    reason TEXT,
    rag_source_ids TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO users (user_id) VALUES ('default');
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """既存テーブルに不足カラムがあれば ALTER TABLE で追加."""
    cursor = conn.execute("PRAGMA table_info(feedback)")
    existing = {row[1] for row in cursor.fetchall()}
    if not existing:
        return  # テーブル自体が無い場合は _SCHEMA の CREATE で作られる

    migrations = [
        ("target_type", "TEXT NOT NULL DEFAULT 'utterance'"),
        ("target_id", "TEXT"),
        ("target_content", "TEXT"),
        ("sentiment", "TEXT NOT NULL DEFAULT 'neutral'"),
        ("source", "TEXT NOT NULL DEFAULT 'implicit'"),
        ("raw_content", "TEXT"),
        ("rag_chunks_used", "TEXT"),
        ("step_index", "INTEGER"),
    ]
    for col, typedef in migrations:
        if col not in existing:
            conn.execute(f"ALTER TABLE feedback ADD COLUMN {col} {typedef}")
            logger.info("Migrated feedback: added column %s", col)


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    try:
        _migrate(conn)
        conn.executescript(_SCHEMA)
        conn.commit()
        logger.info("DB initialized at %s", DB_PATH)
    finally:
        conn.close()


class SqliteFeedbackRepository:
    """FeedbackRepository の SQLite 実装."""

    def __init__(self, db_path: Path = DB_PATH):
        self._db_path = db_path

    def _conn(self) -> sqlite3.Connection:
        return sqlite3.connect(str(self._db_path))

    def save(self, fb: Feedback, user_id: str = "default") -> str:
        fid = str(uuid.uuid4())[:8]
        conn = self._conn()
        try:
            conn.execute(
                """INSERT INTO feedback
                   (feedback_id, user_id, session_id, target_type, target_id,
                    target_content, sentiment, source, raw_content, rag_chunks_used, step_index)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (fid, user_id, fb.session_id, fb.target_type, fb.target_id,
                 fb.target_content, fb.sentiment, fb.source, fb.raw_content, "", fb.step_index),
            )
            conn.commit()
            logger.info("Feedback saved: %s %s/%s", fid, fb.target_type, fb.sentiment)
            return fid
        finally:
            conn.close()

    def save_failed_plan(self, fp: FailedPlan, user_id: str = "default") -> None:
        fid = str(uuid.uuid4())[:8]
        conn = self._conn()
        try:
            conn.execute(
                """INSERT INTO failed_plans
                   (id, user_id, plan_source_id, task_description, abandoned_at_step, reason, rag_source_ids)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (fid, user_id, fp.plan_source_id, fp.task_description,
                 fp.abandoned_at_step, fp.reason, fp.rag_source_ids),
            )
            conn.commit()
        finally:
            conn.close()

    def get_summary(self, days: int = 7) -> list[dict]:
        conn = self._conn()
        try:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """SELECT target_type, sentiment, COUNT(*) as count
                   FROM feedback
                   WHERE created_at > datetime('now', ?)
                   GROUP BY target_type, sentiment
                   ORDER BY count DESC""",
                (f"-{days} days",),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()

    def get_negative_chunks(self, days: int = 7, min_count: int = 2) -> list[dict]:
        conn = self._conn()
        try:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """SELECT target_id as chunk_id, COUNT(*) as negative_count
                   FROM feedback
                   WHERE sentiment = 'negative'
                     AND target_type = 'utterance'
                     AND created_at > datetime('now', ?)
                   GROUP BY target_id
                   HAVING negative_count >= ?
                   ORDER BY negative_count DESC""",
                (f"-{days} days", min_count),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
