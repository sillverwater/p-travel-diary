"""Free, keyless place search via OpenStreetMap (fallback when Kakao finds nothing or no Kakao key is set).

- Nominatim (geocoding): public usage policy = max 1 request/second, identifying User-Agent, cache results.
- Overpass API (nearby POIs by category): fair use; one query per activity.
Data © OpenStreetMap contributors (ODbL). No reviews/ratings exist in OSM; opening_hours tags may be outdated.
"""
import re
import threading
import time

import httpx

from backend.config import settings
from backend.services.places import distance_m

NOMINATIM = "https://nominatim.openstreetmap.org/search"
OVERPASS = "https://overpass-api.de/api/interpreter"
HEADERS = {"User-Agent": "P-travel-diary/0.5 (personal local trip planner)", "Accept-Language": "ko,en"}
ATTRIBUTION = "© OpenStreetMap contributors"

_lock = threading.Lock()
_last_call = 0.0
_cache: dict = {}
CACHE_SECONDS = 24 * 3600

FILTERS = {
    "food": ['["amenity"~"^(restaurant|fast_food|food_court)$"]'],
    "cafe": ['["amenity"~"^(cafe|ice_cream)$"]', '["shop"~"^(bakery|pastry)$"]'],
    "sight": ['["tourism"~"^(attraction|viewpoint|museum|gallery|theme_park|zoo|aquarium)$"]',
              '["natural"="beach"]', '["leisure"~"^(park|garden)$"]', '["historic"]'],
    "shopping": ['["shop"~"^(mall|department_store|gift|souvenir)$"]', '["amenity"="marketplace"]'],
    "stay": ['["tourism"~"^(hotel|guest_house|hostel|motel)$"]'],
    "other": ['["amenity"~"^(restaurant|cafe)$"]', '["tourism"~"^(attraction|viewpoint)$"]'],
}
RADIUS = {"sight": 3000, "shopping": 2500}
LABELS = {"restaurant": "음식점", "fast_food": "패스트푸드", "food_court": "푸드코트", "cafe": "카페", "ice_cream": "아이스크림",
          "bakery": "베이커리", "pastry": "디저트", "attraction": "관광지", "viewpoint": "전망대", "museum": "박물관",
          "gallery": "갤러리", "beach": "해변", "park": "공원", "garden": "정원", "mall": "쇼핑몰", "department_store": "백화점",
          "gift": "기념품점", "souvenir": "기념품점", "marketplace": "시장", "hotel": "호텔", "guest_house": "게스트하우스"}


def enabled():
    return settings.osm_enabled


def _cached(key):
    hit = _cache.get(key)
    return hit[1] if hit and time.time() - hit[0] < CACHE_SECONDS else None


def _store(key, value):
    if len(_cache) > 500:
        _cache.clear()
    _cache[key] = (time.time(), value)
    return value


def geocode(query, limit=3):
    """Nominatim free-text search. Returns [] on any failure (never blocks planning)."""
    query = query.strip()[:200]
    if not query:
        return []
    key = ("geo", query, limit)
    if (hit := _cached(key)) is not None:
        return hit
    global _last_call
    try:
        with _lock:  # Policy: at most one request per second across the app.
            wait = 1.1 - (time.time() - _last_call)
            if wait > 0:
                time.sleep(wait)
            with httpx.Client(timeout=10, headers=HEADERS) as client:
                response = client.get(NOMINATIM, params={"q": query, "format": "jsonv2", "limit": limit, "addressdetails": 1})
            _last_call = time.time()
        if response.status_code != 200:
            return []
        rows = []
        for item in response.json():
            name = item.get("name") or item.get("display_name", "").split(",")[0]
            rows.append({"name": name.strip(), "address": item.get("display_name", "")[:300],
                         "category": LABELS.get(item.get("type", ""), item.get("type", "")),
                         "lat": float(item["lat"]), "lng": float(item["lon"])})
        return _store(key, rows)
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return []


def anchor(query):
    """Unique geocode result only; never silently pick the first of several places."""
    rows = geocode(query, limit=2)
    return rows[0] if len(rows) == 1 else None


def _address(tags):
    if tags.get("addr:full"):
        return tags["addr:full"]
    parts = [tags.get(k, "") for k in ("addr:province", "addr:city", "addr:district", "addr:street", "addr:housenumber")]
    return " ".join(p for p in parts if p).strip()


def nearby(kind, center, radius, keywords, query, limit=5):
    """Named POIs of the activity kind around center; keyword matches first, then distance."""
    filters = FILTERS.get(kind) or FILTERS["other"]
    lat, lng = round(center["lat"], 5), round(center["lng"], 5)
    key = ("near", kind, lat, lng, radius)
    elements = _cached(key)
    if elements is None:
        body = "[out:json][timeout:20];(" + "".join(
            f'nwr(around:{int(radius)},{lat},{lng}){f}["name"];' for f in filters) + ");out center tags 80;"
        try:
            with httpx.Client(timeout=25, headers=HEADERS) as client:
                response = client.post(OVERPASS, data={"data": body})
            if response.status_code != 200:
                return []
            elements = _store(key, response.json().get("elements", []))
        except (httpx.HTTPError, ValueError):
            return []
    tokens = [t for t in re.split(r"\s+", keywords) if len(t) >= 2]
    rows = []
    for element in elements:
        tags = element.get("tags", {})
        point = element if "lat" in element else element.get("center")
        if not point:
            continue
        name = tags.get("name:ko") or tags.get("name", "")
        kind_tag = next((tags[k] for k in ("amenity", "tourism", "shop", "natural", "leisure", "historic") if k in tags), "")
        haystack = " ".join([name, tags.get("name", ""), tags.get("cuisine", ""), tags.get("description", "")]).lower()
        row = {"name": name, "address": _address(tags), "category": LABELS.get(kind_tag, kind_tag),
               "lat": point["lat"], "lng": point["lon"], "query": query, "sort": "osm",
               "opening_hours": tags.get("opening_hours", "")[:120], "cuisine": tags.get("cuisine", "")[:80],
               "match": sum(1 for t in tokens if t.lower() in haystack)}
        row["center_distance_m"] = distance_m(center, row)
        rows.append(row)
    rows.sort(key=lambda r: (-r["match"], r["center_distance_m"]))
    seen, result = set(), []
    for row in rows:
        if row["name"] in seen:
            continue
        seen.add(row["name"])
        row["search_rank"] = len(result) + 1
        result.append(row)
        if len(result) >= limit:
            break
    return result


def search_slot(activity, destination, anchor_point, walking_minutes):
    """Candidates for one activity. Area = stay (if near_anchor) or geocoded search query / destination."""
    if activity.near_anchor and anchor_point:
        center = anchor_point
        radius = max(300, min(walking_minutes * 70 if walking_minutes else 1200, 3000))
    else:
        # search_query is '지역명 + 업종' → try full text, then the area word, then the trip destination.
        first = activity.search_query.split()[0] if activity.search_query.split() else ""
        area = []
        for text in dict.fromkeys(q for q in (activity.search_query, f"{first} {destination}", first, destination) if q.strip()):
            area = geocode(text, limit=1)
            if area:
                break
        if not area:
            return []
        center, radius = area[0], RADIUS.get(activity.kind, 1500)
    keywords = f"{activity.search_query} {activity.title}"
    return nearby(activity.kind, center, radius, keywords, activity.search_query.strip())
