"""Per-segment travel time between two stops, researched with free map services.

- driving: Kakao Mobility directions API (same Kakao REST key) → real route duration/distance (+ parking buffer).
- walking: FOSSGIS OSRM foot profile on OpenStreetMap data (keyless, fair use) → real walking route.
- transit: no free keyless public-transit API → distance-based estimate, clearly labelled.
Any failure falls back to a distance-based estimate so planning never stops.

travel_mode from the UI: 'transit' = 차 없음 (도보 + 대중교통), 'driving' = 차 있음 (도보 + 자동차).
Hops that can be walked in 15 minutes or less (real walking route) are shown as walking.
"""
import math
import threading
import time

import httpx

from backend.config import settings
from backend.services.places import distance_m

WALK_MAX_MINUTES = 15            # 걸어서 15분 이내면 대중교통·자동차 대신 도보로 안내
WALK_SPEED_M_PER_MIN = 70
WALK_CHECK_M = WALK_MAX_MINUTES * WALK_SPEED_M_PER_MIN  # 직선 1,050m 넘으면 15분 안에 걸어갈 수 없음
PARKING_MINUTES = 10
UNKNOWN = {"walking": 20, "transit": 30, "driving": 25}
LABEL = {"walking": "도보", "transit": "대중교통", "driving": "자동차"}
HEADERS = {"User-Agent": "P-travel-diary/0.6 (personal local trip planner)"}
_cache: dict = {}
_lock = threading.Lock()


def _round5(minutes):
    return max(5, int(math.ceil(minutes / 5.0)) * 5)


def _key(a, b, mode):
    return (mode, round(a["lat"], 5), round(a["lng"], 5), round(b["lat"], 5), round(b["lng"], 5))


def _kakao_drive(a, b):
    if not settings.kakao_rest_api_key:
        return None
    try:
        with httpx.Client(timeout=8) as client:
            response = client.get("https://apis-navi.kakaomobility.com/v1/directions",
                                  params={"origin": f"{a['lng']},{a['lat']}", "destination": f"{b['lng']},{b['lat']}", "priority": "RECOMMEND"},
                                  headers={"Authorization": f"KakaoAK {settings.kakao_rest_api_key}"})
        if response.status_code != 200:
            return None
        route = response.json().get("routes", [{}])[0]
        if route.get("result_code") != 0:
            return None
        summary = route["summary"]
        fare = summary.get("fare") or {}
        return summary["duration"] / 60, summary["distance"], fare.get("taxi"), fare.get("toll")
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
        return None


def _osm_walk(a, b):
    try:
        url = f"https://routing.openstreetmap.de/routed-foot/route/v1/driving/{a['lng']},{a['lat']};{b['lng']},{b['lat']}"
        with httpx.Client(timeout=8, headers=HEADERS) as client:
            response = client.get(url, params={"overview": "false"})
        if response.status_code != 200:
            return None
        route = response.json().get("routes", [{}])[0]
        return route["duration"] / 60, route["distance"]
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
        return None


def _walk_leg(a, b, straight):
    """Walking route (OSRM foot) with the raw minutes kept for the 15-minute rule."""
    key = _key(a, b, "walking")
    with _lock:
        if key in _cache:
            return dict(_cache[key])
    found = _osm_walk(a, b)
    if found:
        minutes, meters = found
        result = {"walk_minutes": minutes, "minutes": _round5(minutes), "basis": f"도보 경로 {int(meters)}m (OpenStreetMap)"}
    else:
        minutes = straight * 1.3 / WALK_SPEED_M_PER_MIN
        result = {"walk_minutes": minutes, "minutes": _round5(minutes), "basis": f"직선 {straight}m 기준 도보 추정"}
    result.update(mode="walking", label=LABEL["walking"])
    with _lock:
        _cache[key] = dict(result)
    return result


def segment(a, b, travel_mode):
    """Returns {'minutes', 'mode', 'label', 'basis'} for travelling from point a to point b."""
    if not a or not b:
        mode = "transit" if travel_mode != "driving" else "driving"
        return {"minutes": UNKNOWN[mode], "mode": mode, "label": LABEL[mode], "basis": "위치를 확인하지 못해 기본값으로 잡았어요"}
    straight = distance_m(a, b)
    if straight <= WALK_CHECK_M:
        # Close enough that walking might be quicker than waiting for a bus or parking: check the real walking route.
        walk = _walk_leg(a, b, straight)
        if walk["walk_minutes"] <= WALK_MAX_MINUTES:
            return walk
    mode = "driving" if travel_mode == "driving" else "transit"
    key = _key(a, b, mode)
    with _lock:
        if key in _cache:
            return dict(_cache[key])
    result = None
    if mode == "driving":
        found = _kakao_drive(a, b)
        if found:
            minutes, meters, taxi, toll = found
            result = {"minutes": _round5(minutes + PARKING_MINUTES), "basis": f"카카오내비 경로 {meters / 1000:.1f}km · 주차 여유 {PARKING_MINUTES}분 포함",
                      "road_m": meters, "taxi": taxi, "toll": toll}
        else:
            result = {"minutes": _round5(5 + straight * 1.3 / 450), "basis": f"직선 {straight}m 기준 추정 (카카오 길찾기 응답 없음)",
                      "road_m": int(straight * 1.3)}
    else:
        # Walk to/from stops + ride at ~20km/h on a 1.3x detour. Estimate only.
        result = {"minutes": _round5(12 + straight * 1.3 / 333), "basis": f"직선 {straight / 1000:.1f}km 기준 추정 (대중교통 실시간 경로 미조회)",
                  "road_m": int(straight * 1.3)}
        # Road distance + taxi fare for the same leg from Kakao Mobility (fare basis only).
        found = _kakao_drive(a, b)
        if found:
            result.update(road_m=found[1], taxi=found[2], toll=found[3])
    result.update(mode=mode, label=LABEL[mode])
    with _lock:
        if len(_cache) > 1000:
            _cache.clear()
        _cache[key] = dict(result)
    return result


# ---------- travel cost per leg (KRW, whole party) ----------
TRANSIT_BASE = 1550        # 수도권 지하철 기본요금(교통카드, 10km까지)
FUEL_PRICE = 1700          # 휘발유 원/L (대략)
FUEL_KM_PER_L = 12


def transit_fare(meters):
    """수도권 지하철 거리비례 요금 기준 1인 요금 추정 (10km 기본, 50km까지 5km마다 +100, 이후 8km마다 +100)."""
    km = max(meters, 0) / 1000
    fare = TRANSIT_BASE
    if km > 10:
        fare += 100 * math.ceil((min(km, 50) - 10) / 5)
    if km > 50:
        fare += 100 * math.ceil((km - 50) / 8)
    return fare


def _won(value):
    return f"{int(value):,}원"


def leg_cost(leg, travelers=1, region="domestic"):
    """Returns (cost_krw, note) for one leg. Taxi/toll come from Kakao Mobility; transit fare is a rule-based estimate."""
    if not leg or leg.get("mode") == "walking":
        return 0, "도보 이동 · 교통비 없음"
    if region == "overseas":
        return 0, "해외 구간은 카카오 요금 정보를 쓸 수 없어 교통비를 넣지 않았어요"
    people = max(int(travelers or 1), 1)
    taxi, toll, road = leg.get("taxi"), leg.get("toll"), leg.get("road_m") or 0
    if leg.get("mode") == "driving":
        fuel = round(road / 1000 / FUEL_KM_PER_L * FUEL_PRICE, -2)
        cost = int(fuel + (toll or 0))
        note = f"자동차 · 유류비 약 {_won(fuel)} ({road / 1000:.1f}km, {FUEL_KM_PER_L}km/L·{FUEL_PRICE:,}원/L 가정)"
        note += f" + 통행료 {_won(toll)} (카카오내비)" if toll else " · 통행료 없음"
        return cost, note
    fare = transit_fare(road)
    cost = fare * people
    note = f"대중교통 1인 약 {_won(fare)} × {people}명 = {_won(cost)} (거리 {road / 1000:.1f}km 기준 수도권 요금 추정)"
    if taxi:
        cars = math.ceil(people / 4)
        note += f"\n택시 이용 시 약 {_won(taxi * cars)}" + (f" ({cars}대)" if cars > 1 else "") + " (카카오내비 예상 요금)"
    return cost, note
