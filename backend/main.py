"""Local web UI and persistent travel management API."""

import re
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.config import FRONTEND_DIR, settings
from backend.database import initialize_database
from backend.routers.trips import router as trips_router
from backend.routers.itinerary import router as itinerary_router
from backend.routers.planner import router as planner_router
from backend.routers.maps import router as maps_router
from backend.routers.expenses import router as expenses_router
from backend.routers.documents import router as documents_router


@asynccontextmanager
async def lifespan(app):
    initialize_database()
    # Existing trips: make sure their flights also appear in the itinerary (idempotent).
    from backend.database import connect
    from backend.routers.trips import serialize_row
    from backend.services import flight_items
    with connect() as db:
        flight_items.sync_all(db, serialize_row)
    yield


app = FastAPI(title="P의 여행수첩 API", version="1.0.0", lifespan=lifespan)


def public_closed():
    """True once PUBLIC_UNTIL (local time) has passed. Empty or invalid value = no limit."""
    if not settings.public_until:
        return False
    try:
        until = datetime.fromisoformat(settings.public_until)
    except ValueError:
        return False
    now = datetime.now(until.tzinfo) if until.tzinfo else datetime.now()
    return now >= until


CLOSED_PAGE = """<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>P의 여행수첩</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#5bb381;font-family:system-ui,sans-serif">
<div style="padding:32px 40px;border-radius:24px;background:#fffdf4;color:#3f3124;text-align:center">
<h1 style="margin:0 0 8px;font-size:1.4rem">체험 기간이 끝났어요</h1><p style="margin:0">P의 여행수첩을 체험해 주셔서 고마워요.</p></div></body></html>"""


@app.middleware("http")
async def close_after_public_period(request, call_next):
    if public_closed():
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": "체험 기간이 끝났어요."}, status_code=410)
        return HTMLResponse(CLOSED_PAGE, status_code=410)
    return await call_next(request)


@app.middleware("http")
async def no_stale_frontend(request, call_next):
    """Always revalidate the page and its JS/CSS so code changes show up without cache problems."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response
app.include_router(trips_router)
app.include_router(itinerary_router)
app.include_router(planner_router)
app.include_router(maps_router)
app.include_router(expenses_router)
app.include_router(documents_router)

IMAGE_NAME = re.compile(r"^[A-Za-z0-9_.-]+\.(png|jpg|jpeg|webp|svg)$")


@app.get("/static/img/{name}", include_in_schema=False)
def image(name: str):
    """Personal images in frontend/img (not shared, e.g. 동물의 숲) win; otherwise the free set in frontend/img-free."""
    if not IMAGE_NAME.match(name):
        raise HTTPException(404)
    for folder in (FRONTEND_DIR / "img", FRONTEND_DIR / "img-free"):
        path = folder / name
        if path.is_file():
            return FileResponse(path)
    raise HTTPException(404)


# Only frontend assets are public. Never mount the project root or data folder.
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(FRONTEND_DIR / "index.html")


def place_provider():
    from backend.services import kakao, osm
    from backend.services.places import configured as naver_configured
    if naver_configured():
        return "naver"
    if kakao.configured():
        return "kakao"
    return "osm" if osm.enabled() else "none"


@app.get("/api/health", tags=["system"])
def health():
    return {"status": "ok", "app": "travel-planner", "version": "1.0.0", "place_provider": place_provider()}


@app.get("/api/diagnostics/kakao", tags=["system"])
def kakao_diagnostics():
    """One tiny call per Kakao API to confirm the key works. Never returns the key itself."""
    import httpx
    from backend.config import settings
    if not settings.kakao_rest_api_key:
        return {"key_loaded": False, "hint": ".env에 KAKAO_REST_API_KEY를 저장한 뒤 서버를 다시 실행하세요."}
    headers = {"Authorization": f"KakaoAK {settings.kakao_rest_api_key}"}
    checks = {
        "local_keyword": ("https://dapi.kakao.com/v2/local/search/keyword.json", {"query": "부산역", "size": 1}),
        "blog_search": ("https://dapi.kakao.com/v2/search/blog", {"query": "부산 여행", "size": 1}),
        "car_directions": ("https://apis-navi.kakaomobility.com/v1/directions",
                           {"origin": "129.0403,35.1151", "destination": "129.1186,35.1532"}),
    }
    result = {"key_loaded": True, "place_provider": place_provider()}
    with httpx.Client(timeout=8) as client:
        for name, (url, params) in checks.items():
            try:
                response = client.get(url, params=params, headers=headers)
                body = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
                result[name] = {"http_status": response.status_code, "ok": response.status_code == 200,
                                "message": (body.get("message") or body.get("msg") or "")[:200] if isinstance(body, dict) else ""}
            except httpx.HTTPError as exc:
                result[name] = {"ok": False, "message": type(exc).__name__}
    return result
