"""Resolve paths relative to the project, never the current working directory."""

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

PROJECT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_DIR / "frontend"
# Folder for the database. Set APP_DATA_DIR (e.g. data-public) to keep a public demo apart from your own trips.

load_dotenv(PROJECT_DIR / ".env")
DATA_DIR = PROJECT_DIR / (os.getenv("APP_DATA_DIR", "data").strip() or "data")


@dataclass(frozen=True)
class Settings:
    # repr=False prevents accidental disclosure when printing the settings object.
    openai_api_key: str = field(default_factory=lambda: os.getenv("OPENAI_API_KEY", ""), repr=False)
    openai_model: str = field(default_factory=lambda: os.getenv("OPENAI_MODEL", ""))
    openai_embedding_model: str = field(default_factory=lambda: os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"))
    kakao_rest_api_key: str = field(default_factory=lambda: os.getenv("KAKAO_REST_API_KEY", "").strip(), repr=False)
    naver_client_id: str = field(default_factory=lambda: os.getenv("NAVER_CLIENT_ID", ""), repr=False)
    naver_client_secret: str = field(default_factory=lambda: os.getenv("NAVER_CLIENT_SECRET", ""), repr=False)
    osm_enabled: bool = field(default_factory=lambda: os.getenv("OSM_ENABLED", "true").strip().lower() not in {"0", "false", "no", "off"})
    port: int = field(default_factory=lambda: int(os.getenv("APP_PORT", "8000")))
    # Public demo end time (local, e.g. 2026-11-18T09:00). After it, every page and API answers "공개 기간 종료".
    public_until: str = field(default_factory=lambda: os.getenv("PUBLIC_UNTIL", "").strip())


settings = Settings()
