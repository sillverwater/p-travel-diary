from datetime import datetime, timezone
from uuid import uuid4
import json

from fastapi import APIRouter, HTTPException, Response

from backend.database import connect
from backend.schemas import Trip, TripInput
from backend.services import flight_items

router = APIRouter(prefix="/api/trips", tags=["trips"])


def serialize_row(row):
    result = dict(row)
    conditions = json.loads(result.pop("conditions", "{}"))
    result.update(conditions)
    return result


def serialize_conditions(payload):
    return json.dumps(payload.model_dump(mode="json", exclude={"title", "destination", "start_date", "end_date"}), ensure_ascii=False)


def get_row(db, trip_id):
    row = db.execute("SELECT * FROM trips WHERE id = ?", (trip_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "여행을 찾을 수 없습니다.")
    return serialize_row(row)


@router.get("", response_model=list[Trip])
def list_trips():
    with connect() as db:
        return [serialize_row(row) for row in db.execute("SELECT * FROM trips ORDER BY created_at DESC, id")]


@router.post("", response_model=Trip, status_code=201)
def create_trip(payload: TripInput):
    trip_id = uuid4().hex
    now = datetime.now(timezone.utc).isoformat()
    with connect() as db:
        db.execute(
            "INSERT INTO trips (id, title, destination, start_date, end_date, created_at, updated_at, conditions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (trip_id, payload.title, payload.destination, payload.start_date.isoformat(), payload.end_date.isoformat(), now, now, serialize_conditions(payload)),
        )
        flight_items.sync(db, get_row(db, trip_id))
        return get_row(db, trip_id)


@router.get("/{trip_id}", response_model=Trip)
def get_trip(trip_id: str):
    with connect() as db:
        return get_row(db, trip_id)


@router.put("/{trip_id}", response_model=Trip)
def update_trip(trip_id: str, payload: TripInput):
    with connect() as db:
        get_row(db, trip_id)
        outside = db.execute(
            "SELECT id FROM itinerary_items WHERE trip_id=? AND source NOT LIKE 'flight:%' AND (date < ? OR date > ?) LIMIT 1",
            (trip_id, payload.start_date.isoformat(), payload.end_date.isoformat()),
        ).fetchone()
        if outside:
            raise HTTPException(422, "변경할 여행 기간 밖에 일정이 있습니다. 해당 일정을 옮기거나 삭제한 후 기간을 변경해주세요.")
        spent_outside = db.execute(
            "SELECT id FROM expenses WHERE trip_id=? AND (date < ? OR date > ?) LIMIT 1",
            (trip_id, payload.start_date.isoformat(), payload.end_date.isoformat()),
        ).fetchone()
        if spent_outside:
            raise HTTPException(422, "변경할 여행 기간 밖에 지출 기록이 있습니다. 해당 지출의 날짜를 옮기거나 삭제한 후 기간을 변경해주세요.")
        db.execute(
            "UPDATE trips SET title = ?, destination = ?, start_date = ?, end_date = ?, updated_at = ?, conditions = ? WHERE id = ?",
            (payload.title, payload.destination, payload.start_date.isoformat(), payload.end_date.isoformat(), datetime.now(timezone.utc).isoformat(), serialize_conditions(payload), trip_id),
        )
        flight_items.sync(db, get_row(db, trip_id))
        return get_row(db, trip_id)


@router.delete("/{trip_id}", status_code=204)
def delete_trip(trip_id: str):
    with connect() as db:
        get_row(db, trip_id)
        db.execute("DELETE FROM trips WHERE id = ?", (trip_id,))
    return Response(status_code=204)
