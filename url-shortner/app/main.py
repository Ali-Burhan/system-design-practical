import secrets
import string
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, status
from fastapi.responses import RedirectResponse
from redis.exceptions import RedisError
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError

from app.database import Base, engine, session_factory
from app.models import ShortURL
from app.redis import redis_client
from app.schemas import CreateURLRequest, URLResponse


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield
    await redis_client.aclose()
    await engine.dispose()


app = FastAPI(title="URL Shortener API", version="0.1.0", lifespan=lifespan)
api_instance = os.getenv("API_INSTANCE", "local")


@app.middleware("http")
async def add_instance_header(request, call_next):
    response = await call_next(request)
    response.headers["X-API-Instance"] = api_instance
    response.headers.setdefault("X-Cache", "BYPASS")
    return response


def generate_short_code() -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(7))


@app.get("/")
async def root() -> dict[str, str]:
    return {"message": "Welcome to the URL Shortener API", "instance": api_instance}


@app.get("/health")
async def health_check() -> dict[str, str]:
    async with engine.connect() as connection:
        await connection.execute(text("SELECT 1"))

    return {"status": "ok", "database": "connected", "instance": api_instance}


@app.post("/urls", response_model=URLResponse, status_code=status.HTTP_201_CREATED)
async def create_url(request: CreateURLRequest) -> URLResponse:
    short_code = request.short_code or generate_short_code()

    async with session_factory() as session:
        existing = await session.scalar(
            select(ShortURL).where(ShortURL.short_code == short_code)
        )
        if existing:
            raise HTTPException(status_code=409, detail="Short code already exists")

        short_url = ShortURL(short_code=short_code, target_url=str(request.target_url))
        session.add(short_url)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            raise HTTPException(status_code=409, detail="Short code already exists")
        await session.refresh(short_url)

        return short_url


@app.get("/urls/{short_code}", response_model=URLResponse)
async def get_url(short_code: str) -> URLResponse:
    async with session_factory() as session:
        short_url = await session.scalar(
            select(ShortURL).where(ShortURL.short_code == short_code)
        )
        if short_url is None:
            raise HTTPException(status_code=404, detail="Short URL not found")

        try:
            cache_status = (
                "HIT" if await redis_client.exists(f"short_url:{short_code}") else "MISS"
            )
        except RedisError:
            cache_status = "MISS"

        if cache_status == "MISS":
            try:
                await redis_client.set(
                    f"short_url:{short_code}", short_url.target_url, ex=3600
                )
            except RedisError:
                pass

        return URLResponse(
            short_code=short_url.short_code,
            target_url=short_url.target_url,
            clicks=short_url.clicks,
            created_at=short_url.created_at,
            cache_status=cache_status,
        )


@app.delete("/urls/{short_code}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_url(short_code: str) -> None:
    async with session_factory() as session:
        short_url = await session.scalar(
            select(ShortURL).where(ShortURL.short_code == short_code)
        )
        if short_url is None:
            raise HTTPException(status_code=404, detail="Short URL not found")
        await session.delete(short_url)
        await session.commit()

    try:
        await redis_client.delete(f"short_url:{short_code}")
    except RedisError:
        pass


@app.get("/{short_code}", response_class=RedirectResponse, status_code=307)
async def redirect_to_target(short_code: str) -> RedirectResponse:
    cache_key = f"short_url:{short_code}"
    cache_status = "HIT"

    try:
        target_url = await redis_client.get(cache_key)
    except RedisError:
        target_url = None
        cache_status = "MISS"

    async with session_factory() as session:
        if target_url is None:
            cache_status = "MISS"
            short_url = await session.scalar(
                select(ShortURL).where(ShortURL.short_code == short_code)
            )
            if short_url is None:
                raise HTTPException(status_code=404, detail="Short URL not found")
            target_url = short_url.target_url
            try:
                await redis_client.set(cache_key, target_url, ex=3600)
            except RedisError:
                pass

        await session.execute(
            update(ShortURL)
            .where(ShortURL.short_code == short_code)
            .values(clicks=ShortURL.clicks + 1)
        )
        await session.commit()
        response = RedirectResponse(url=target_url, status_code=307)
        response.headers["X-Cache"] = cache_status
        return response
