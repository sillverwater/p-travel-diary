"""Official Naver Local + Blog Search only (free developer APIs); no scraping or paid Maps APIs."""
import html
import math
import re

import httpx

from backend.config import settings
from backend.services.place_names import normalize_place_name


class PlaceSearchError(Exception):
    pass


def configured():
    return bool(settings.naver_client_id and settings.naver_client_secret)


def clean(value):
    return html.unescape(re.sub(r"<[^>]*>", "", str(value)))


def resolve_candidate(candidate_id, location, candidates):
    """Repair formatting or missing IDs only when the match is unambiguous."""
    value = candidate_id.strip().lower()
    direct = [row for row in candidates if row["candidate_id"].lower() == value]
    if len(direct) == 1:
        return direct[0]
    # Exact location/name matches only; no fuzzy guesses or first-result fallback.
    normalize = lambda text: re.sub(r"\s+", "", clean(text)).casefold()
    place = normalize(location)
    matches = [row for row in candidates if place in {
        normalize(row["name"]), normalize(row["name"] + ', ' + row["address"]),
        normalize(row["name"] + ' ' + row["address"]), normalize(row["address"]),
    } and place]
    return matches[0] if len(matches) == 1 else None


def search(query, sort="comment"):
    query = normalize_place_name(query)
    if not configured():
        raise PlaceSearchError("네이버 검색 키가 없습니다. .env에 NAVER_CLIENT_ID와 NAVER_CLIENT_SECRET을 설정해주세요.")
    try:
        with httpx.Client(timeout=10, follow_redirects=False) as client:
            response = client.get("https://openapi.naver.com/v1/search/local.json",
                params={"query": query[:200], "display": 5, "start": 1, "sort": sort},
                headers={"X-Naver-Client-Id": settings.naver_client_id,
                         "X-Naver-Client-Secret": settings.naver_client_secret})
        if response.status_code in {401, 403}:
            raise PlaceSearchError("네이버 검색 키와 검색 API 권한을 확인해주세요.")
        if response.status_code == 429:
            raise PlaceSearchError("네이버 검색 호출 한도에 도달했습니다.")
        if response.status_code != 200:
            raise PlaceSearchError("네이버 지역 검색을 사용할 수 없습니다. 잠시 후 다시 시도해주세요.")
        results = []
        for rank, row in enumerate(response.json().get("items", []), 1):
            try:
                lng, lat = float(row["mapx"]) / 10_000_000, float(row["mapy"]) / 10_000_000
                if not (124 <= lng <= 132 and 32 <= lat <= 39):
                    continue
            except (KeyError, ValueError, TypeError):
                continue
            results.append({"name": clean(row.get("title", "")), "address": clean(row.get("roadAddress") or row.get("address", "")),
                "category": clean(row.get("category", "")), "lng": lng, "lat": lat,
                "search_rank": rank, "query": query, "sort": sort})
        return results
    except PlaceSearchError:
        raise
    except (httpx.HTTPError, ValueError, TypeError):
        raise PlaceSearchError("네이버 검색 연결 또는 응답 처리에 실패했습니다.") from None


def blog_search(query, display=3):
    """Blog snippets used as evidence. Failures return [] so planning can continue."""
    if not configured() or not query.strip():
        return []
    try:
        with httpx.Client(timeout=8, follow_redirects=False) as client:
            response = client.get("https://openapi.naver.com/v1/search/blog.json",
                params={"query": query[:200], "display": display, "start": 1, "sort": "sim"},
                headers={"X-Naver-Client-Id": settings.naver_client_id,
                         "X-Naver-Client-Secret": settings.naver_client_secret})
        if response.status_code != 200:
            return []
        posts = []
        for row in response.json().get("items", []):
            link = str(row.get("link", ""))
            if not link.startswith("https://"):
                continue
            posts.append({"title": clean(row.get("title", ""))[:120],
                          "snippet": clean(row.get("description", ""))[:220],
                          "url": link[:500], "postdate": str(row.get("postdate", ""))[:8]})
        return posts
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        return []


def distance_m(a, b):
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    delta_lat, delta_lng = lat2 - lat1, math.radians(b["lng"] - a["lng"])
    h = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lng / 2) ** 2
    return round(6371000 * 2 * math.asin(min(1, math.sqrt(h))))


def anchor_result(query):
    rows = search(query, "random")
    # Never silently pick the first of multiple hotels or branches.
    return rows[0] if len(rows) == 1 else None


def recommendations(intent):
    anchor = anchor_result(intent.anchor_query) if intent.anchor_query else None
    candidates, seen = [], set()
    for query in intent.queries[:4]:
        for row in search(query):
            key = (row["name"], row["address"])
            if key in seen:
                continue
            seen.add(key)
            row["distance_m"] = distance_m(anchor, row) if anchor else None
            if row["distance_m"] is not None and intent.walking_minutes > 0:
                # Upper-bound screening only, NOT a guarantee of actual walkability.
                if row["distance_m"] > intent.walking_minutes * 70:
                    continue
            row["candidate_id"] = f"naver-{len(candidates) + 1}"
            candidates.append(row)
    return {"anchor": anchor, "anchor_query": intent.anchor_query,
        "walking_minutes_requested": intent.walking_minutes, "candidates": candidates,
        "limitations": ["검색어별 최대 5개 결과만 비교합니다. 지역 전체의 리뷰 최다 업체를 보장하지 않습니다.",
            "search_rank는 네이버 카페·블로그 리뷰순 검색 순위이며 방문자 리뷰 수나 평점이 아닙니다.",
            "직선거리 1분당 70m 기준으로 먼 후보만 제외합니다. 실제 도보 시간·횡단보도·강·언덕은 확인하지 않습니다.",
            "숙소 검색 결과가 여러 개면 기준 좌표를 확정하지 않으며 거리 조건은 미검증입니다."]}
