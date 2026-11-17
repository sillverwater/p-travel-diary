"""Kakao Local API (place keyword/address search) + Daum blog search with one REST API key.

Official endpoints on dapi.kakao.com with header `Authorization: KakaoAK {REST_API_KEY}`.
Domestic (Korea) places only. No ratings/reviews are provided by the API.
"""
import html
import re

import httpx

from backend.config import settings
from backend.services.place_names import normalize_place_name

BASE = "https://dapi.kakao.com"
# Kakao category_group_code: FD6 음식점, CE7 카페, AT4 관광명소, CT1 문화시설, MT1 대형마트, AD5 숙박
CATEGORY = {"food": "FD6", "cafe": "CE7", "stay": "AD5"}


class KakaoError(Exception):
    pass


def configured():
    return bool(settings.kakao_rest_api_key)


def _get(path, params):
    if not configured():
        raise KakaoError("카카오 REST API 키가 없습니다. .env에 KAKAO_REST_API_KEY를 설정해주세요.")
    try:
        with httpx.Client(timeout=10, follow_redirects=False) as client:
            response = client.get(BASE + path, params=params,
                                  headers={"Authorization": f"KakaoAK {settings.kakao_rest_api_key}"})
    except httpx.HTTPError:
        raise KakaoError("카카오 API 연결에 실패했습니다. 잠시 후 다시 시도해주세요.") from None
    if response.status_code in {401, 403}:
        raise KakaoError("카카오 REST API 키 또는 앱의 카카오맵(로컬) 사용 설정을 확인해주세요.")
    if response.status_code == 429:
        raise KakaoError("카카오 API 호출 한도에 도달했습니다.")
    if response.status_code != 200:
        raise KakaoError("카카오 API를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.")
    try:
        return response.json()
    except ValueError:
        raise KakaoError("카카오 API 응답을 처리하지 못했습니다.") from None


def _documents(path, params):
    return _get(path, params).get("documents", [])


def _place(doc, rank, query):
    return {"name": doc.get("place_name", "").strip(),
            "address": (doc.get("road_address_name") or doc.get("address_name") or "").strip(),
            "category": doc.get("category_name", "").split(" > ")[-1].strip(),
            "category_path": doc.get("category_name", ""),
            "group": doc.get("category_group_code", ""),  # FD6 음식점, CE7 카페, AT4 관광명소, CT1 문화시설, AD5 숙박, MT1 대형마트
            "lng": float(doc["x"]), "lat": float(doc["y"]),
            "place_url": doc.get("place_url", "") if str(doc.get("place_url", "")).startswith("http") else "",
            "phone": doc.get("phone", ""), "kakao_id": str(doc.get("id", "")),
            "search_rank": rank, "query": query, "sort": "kakao"}


def keyword(query, center=None, radius=None, size=8, category=None, sort="accuracy"):
    query = normalize_place_name(query)[:100]
    params = {"query": query, "size": max(1, min(size, 15)), "sort": sort}
    if center:
        params.update({"x": center["lng"], "y": center["lat"]})
        if radius:
            params["radius"] = int(max(1, min(radius, 20000)))
    if category:
        params["category_group_code"] = category
    rows = []
    for rank, doc in enumerate(_documents("/v2/local/search/keyword.json", params), 1):
        try:
            rows.append(_place(doc, rank, query))
        except (KeyError, ValueError, TypeError):
            continue
    return rows


def address(query):
    """Address -> single coordinate (only when unique)."""
    docs = _documents("/v2/local/search/address.json", {"query": query[:200], "size": 2})
    if len(docs) != 1:
        return None
    doc = docs[0]
    try:
        return {"name": query, "address": doc.get("address_name", query), "lng": float(doc["x"]), "lat": float(doc["y"])}
    except (KeyError, ValueError, TypeError):
        return None


def _compact(text):
    return re.sub(r"\s+", "", text or "").casefold()


def anchor(stay_name, stay_address, fallback_query=""):
    """Stay coordinates: unique address match, else the single keyword result whose name equals the stay name."""
    if stay_address:
        point = address(stay_address)
        if point:
            return {**point, "name": stay_name or stay_address}
    query = stay_name or fallback_query
    if not query:
        return None
    rows = keyword(query, size=5)
    exact = [row for row in rows if _compact(row["name"]) == _compact(query)]
    if len(exact) == 1:
        return exact[0]
    return rows[0] if len(rows) == 1 else None


def resolve(query, size=5):
    """Candidates for map links (user picks; never auto-pick among several)."""
    return keyword(query, size=size)


def blog_stats(query, size=3):
    """Daum blog search: total post count (popularity proxy, NOT a rating) + top posts. Failure -> (None, [])."""
    if not configured() or not query.strip():
        return None, []
    try:
        data = _get("/v2/search/blog", {"query": query[:200], "size": size, "sort": "accuracy"})
    except KakaoError:
        return None, []
    total = data.get("meta", {}).get("total_count")
    return (int(total) if isinstance(total, int) else None), _posts(data.get("documents", []))


def blog_search(query, size=3):
    return blog_stats(query, size)[1]


def _posts(docs):
    clean = lambda value: html.unescape(re.sub(r"<[^>]*>", "", str(value)))
    posts = []
    for doc in docs:
        url = str(doc.get("url", ""))
        if not url.startswith("https://") and not url.startswith("http://"):
            continue
        posts.append({"title": clean(doc.get("title", ""))[:120], "snippet": clean(doc.get("contents", ""))[:220],
                      "url": url[:500], "postdate": str(doc.get("datetime", ""))[:10]})
    return posts
