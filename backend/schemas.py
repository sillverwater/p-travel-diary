"""Travel settings and reservation validation."""
from datetime import date, datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator
from backend.services.place_names import normalize_place_name

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
LongText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=3000)]
Money = Annotated[int, Field(strict=True, ge=0, le=1_000_000_000_000)]


class Flight(BaseModel):
    model_config = ConfigDict(extra="forbid")
    flight_number: str = Field(default="", max_length=50)
    departure_airport: ShortText
    arrival_airport: ShortText
    departure_at: datetime
    arrival_at: datetime
    departure_timezone: str = "Asia/Seoul"
    arrival_timezone: str = "Asia/Seoul"
    cost_krw: Money = 0

    @field_validator("departure_airport", "arrival_airport")
    @classmethod
    def normalize_airport(cls, value):
        return normalize_place_name(value)

    @field_validator("departure_timezone", "arrival_timezone")
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("시간대는 Asia/Seoul, Asia/Tokyo 같은 IANA 이름으로 입력해주세요.") from None
        return value

    @model_validator(mode="after")
    def valid_times(self):
        if self.departure_at.tzinfo is not None or self.arrival_at.tzinfo is not None:
            raise ValueError("항공 시각은 오프셋 없이 현지 시각으로 입력하고 시간대를 별도로 지정해주세요.")
        departure = self.departure_at.replace(tzinfo=ZoneInfo(self.departure_timezone)).timestamp()
        arrival = self.arrival_at.replace(tzinfo=ZoneInfo(self.arrival_timezone)).timestamp()
        if arrival <= departure:
            raise ValueError("항공 도착 시각은 시간대를 고려했을 때 출발 시각보다 늦어야 합니다.")
        return self


class Accommodation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: ShortText
    address: LongText = ""
    check_in: datetime
    check_out: datetime
    timezone: str = "Asia/Seoul"
    cost_krw: Money = 0

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value):
        return Flight.valid_timezone(value)

    @model_validator(mode="after")
    def valid_times(self):
        if self.check_in.tzinfo is not None or self.check_out.tzinfo is not None:
            raise ValueError("체크인·아웃은 오프셋 없는 현지 시각으로 입력해주세요.")
        zone = ZoneInfo(self.timezone)
        if self.check_out.replace(tzinfo=zone).timestamp() <= self.check_in.replace(tzinfo=zone).timestamp():
            raise ValueError("체크아웃은 체크인보다 늦어야 합니다.")
        return self


class GroundTrip(BaseModel):
    """Domestic train/bus segment or own-car drive (local times, Asia/Seoul)."""
    model_config = ConfigDict(extra="forbid")
    mode: Literal["train", "bus", "car"]
    label: str = Field(default="", max_length=50)  # e.g. KTX 101, 고속버스 노선
    from_place: ShortText
    to_place: ShortText
    departure_at: datetime | None = None
    arrival_at: datetime | None = None
    cost_krw: Money = 0

    @field_validator("departure_at", "arrival_at", mode="before")
    @classmethod
    def blank_is_none(cls, value):
        return None if value in ("", None) else value

    @model_validator(mode="after")
    def valid_times(self):
        for value in (self.departure_at, self.arrival_at):
            if value is not None and value.tzinfo is not None:
                raise ValueError("기차·버스·자차 시각은 오프셋 없는 현지 시각으로 입력해주세요.")
        if self.departure_at and self.arrival_at and self.arrival_at <= self.departure_at:
            raise ValueError("도착 시각은 출발 시각보다 늦어야 합니다.")
        if self.mode != "car" and self.departure_at is None:
            raise ValueError("기차·버스는 출발 날짜·시간을 입력해주세요.")
        return self


class TripInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: ShortText
    destination: ShortText
    start_date: date
    end_date: date
    travelers: int = Field(default=1, ge=1, le=100)
    # 국내/해외, 여행지까지 가는 방법, 현지에서 차 이용 여부 (older trips default to 국내·비행기).
    region: Literal["domestic", "overseas"] = "domestic"
    access: Literal["flight", "train_bus", "car"] = "flight"
    local_car: bool = False
    budget_krw: Money = 0
    travel_style: LongText = ""
    must_visit_places: list[ShortText] = Field(default_factory=list, max_length=100)
    flights: list[Flight] = Field(default_factory=list, max_length=30)
    accommodations: list[Accommodation] = Field(default_factory=list, max_length=30)
    ground: list[GroundTrip] = Field(default_factory=list, max_length=30)  # 기차·버스 구간 또는 자차 이동

    @model_validator(mode="after")
    def check_dates(self):
        if self.end_date < self.start_date:
            raise ValueError("종료일은 시작일보다 빠를 수 없습니다.")
        if self.region == "overseas" and self.access != "flight":
            raise ValueError("해외여행은 비행기로 가는 것으로 설정해주세요.")
        if self.access != "flight" and self.flights:
            raise ValueError("비행기로 가지 않는 여행에는 항공편을 저장하지 않아요. 가는 방법을 확인해주세요.")
        allowed = {"flight": set(), "train_bus": {"train", "bus"}, "car": {"car"}}[self.access]
        if any(segment.mode not in allowed for segment in self.ground):
            raise ValueError("가는 방법과 맞지 않는 기차·버스·자차 정보가 있어요. 가는 방법을 확인해주세요.")
        for stay in self.accommodations:
            if stay.check_in.date() < self.start_date or stay.check_out.date() > self.end_date:
                raise ValueError("숙소 체크인·아웃 날짜는 여행 기간 안에 있어야 합니다.")
        return self


class Trip(TripInput):
    id: str
    created_at: datetime
    updated_at: datetime
