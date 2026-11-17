"""Persistent SQLite storage, independent of the shell's working directory."""
import sqlite3
from contextlib import contextmanager

from backend.config import DATA_DIR

DB_PATH = DATA_DIR / "travel.db"


@contextmanager
def connect():
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_database():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS trips (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                destination TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        # Additive migration: keep every existing trip and its original dates.
        columns = {row["name"] for row in db.execute("PRAGMA table_info(trips)")}
        if "conditions" not in columns:
            db.execute("ALTER TABLE trips ADD COLUMN conditions TEXT NOT NULL DEFAULT '{}'")
        db.execute("""
            CREATE TABLE IF NOT EXISTS itinerary_items (
                id TEXT PRIMARY KEY,
                trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
                date TEXT NOT NULL,
                time TEXT NOT NULL,
                title TEXT NOT NULL,
                location TEXT NOT NULL,
                category TEXT NOT NULL,
                estimated_cost_krw INTEGER NOT NULL DEFAULT 0,
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)
        db.execute("CREATE INDEX IF NOT EXISTS idx_itinerary_trip_date ON itinerary_items(trip_id, date, time)")
        # Additive migration: auto-generated items (e.g. from flights) carry a source key.
        item_columns = {row["name"] for row in db.execute("PRAGMA table_info(itinerary_items)")}
        if "source" not in item_columns:
            db.execute("ALTER TABLE itinerary_items ADD COLUMN source TEXT NOT NULL DEFAULT ''")
        db.execute("""CREATE TABLE IF NOT EXISTS plan_drafts (
            id TEXT PRIMARY KEY,
            trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
            date TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            payload TEXT NOT NULL,
            applied INTEGER NOT NULL DEFAULT 0
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS planning_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
            date TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL
        )""")
        # Additive migration: when each chat message was sent (local time). Older rows stay empty.
        message_columns = {row["name"] for row in db.execute("PRAGMA table_info(planning_messages)")}
        if "created_at" not in message_columns:
            db.execute("ALTER TABLE planning_messages ADD COLUMN created_at TEXT NOT NULL DEFAULT ''")
        # Travel ledger: actual spending during the trip (separate from booking costs).
        db.execute("""CREATE TABLE IF NOT EXISTS expenses (
            id TEXT PRIMARY KEY,
            trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
            date TEXT NOT NULL,
            title TEXT NOT NULL,
            category TEXT NOT NULL,
            amount_krw INTEGER NOT NULL,
            payment TEXT NOT NULL DEFAULT 'card',
            memo TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS idx_expenses_trip_date ON expenses(trip_id, date)")
        # RAG: extracted text only (original files are not stored).
        db.execute("""CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            chars INTEGER NOT NULL,
            chunks INTEGER NOT NULL,
            created_at TEXT NOT NULL
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS doc_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            content TEXT NOT NULL,
            embedding BLOB NOT NULL
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS idx_doc_chunks_trip ON doc_chunks(trip_id)")
