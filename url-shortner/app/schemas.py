from datetime import datetime

from pydantic import AnyHttpUrl, BaseModel, Field


class CreateURLRequest(BaseModel):
    target_url: AnyHttpUrl
    short_code: str | None = Field(default=None, min_length=3, max_length=32)


class URLResponse(BaseModel):
    short_code: str
    target_url: AnyHttpUrl
    clicks: int
    created_at: datetime
    cache_status: str = "BYPASS"