"""Manual day plans. No external APIs or LLM calls."""
from datetime import date, datetime, time, timezone
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, field_validator
from typing import Literal

from backend.database import connect
from backend.routers.trips import get_row
from backend.schemas import LongText, Money, ShortText

router = APIRouter(prefix="/api/trips/{trip_id}/itinerary", tags=["itinerary"])


class ItemInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: date
    time: time
    title: ShortText
    location: LongText = ""
    category: Literal["visit", "flight", "stay", "food", "transfer", "other"] = "visit"
    estimated_cost_krw: Money = 0
    notes: LongText = ""

    @field_validator("time")
    @classmethod
    def local_time(cls, value):
        if value.tzinfo is not None:
            raise ValueError("일정 시간은 현지 시각으로 입력해주세요.")
        return value


class Item(ItemInput):
    id: str
    source: str = ""
    trip_id: str
    created_at: datetime


def check_date(db, trip_id, day):
    trip = get_row(db, trip_id)
    if not trip["start_date"] <= day.isoformat() <= trip["end_date"]:
        raise HTTPException(422, "일정 날짜는 여행 기간 안에 있어야 합니다.")


def item_row(db, trip_id, item_id):
    row = db.execute("SELECT * FROM itinerary_items WHERE trip_id = ? AND id = ?", (trip_id, item_id)).fetchone()
    if row is None:
        raise HTTPException(404, "일정을 찾을 수 없습니다.")
    return dict(row)


@router.get("", response_model=list[Item])
def list_items(trip_id: str):
    with connect() as db:
        get_row(db, trip_id)
        return [dict(row) for row in db.execute(
            "SELECT * FROM itinerary_items WHERE trip_id = ? ORDER BY date, time, created_at, id", (trip_id,)
        )]


@router.post("", response_model=Item, status_code=201)
def create_item(trip_id: str, payload: ItemInput):
    with connect() as db:
        check_date(db, trip_id, payload.date)
        item_id = uuid4().hex
        db.execute(
            "INSERT INTO itinerary_items (id, trip_id, date, time, title, location, category, estimated_cost_krw, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (item_id, trip_id, payload.date.isoformat(), payload.time.isoformat(), payload.title,
             payload.location, payload.category, payload.estimated_cost_krw, payload.notes, datetime.now(timezone.utc).isoformat()),
        )
        return item_row(db, trip_id, item_id)


@router.put("/{item_id}", response_model=Item)
def update_item(trip_id: str, item_id: str, payload: ItemInput):
    with connect() as db:
        check_date(db, trip_id, payload.date)
        item_row(db, trip_id, item_id)
        db.execute(
            "UPDATE itinerary_items SET date=?, time=?, title=?, location=?, category=?, estimated_cost_krw=?, notes=? WHERE trip_id=? AND id=?",
            (payload.date.isoformat(), payload.time.isoformat(), payload.title, payload.location,
             payload.category, payload.estimated_cost_krw, payload.notes, trip_id, item_id),
        )
        return item_row(db, trip_id, item_id)


@router.delete("/{item_id}", status_code=204)
def delete_item(trip_id: str, item_id: str):
    with connect() as db:
        get_row(db, trip_id)
        item_row(db, trip_id, item_id)
        db.execute("DELETE FROM itinerary_items WHERE trip_id=? AND id=?", (trip_id, item_id))
    return Response(status_code=204)
