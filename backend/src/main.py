import logging
import warnings
from contextlib import asynccontextmanager

# milvus-lite が内部で deprecated な pkg_resources を使っている (upstream未修正)
warnings.filterwarnings("ignore", message="pkg_resources is deprecated", category=UserWarning)

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .common.exceptions import DomainException, ValidationError
from .config import settings
from .routes import api_router

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Guidey API...")
    # パーソナライズDB初期化
    from .infrastructure.repositories.feedback_repository import init_db
    try:
        init_db()
    except Exception:
        logger.warning("Failed to init personalization DB", exc_info=True)
    yield
    logger.info("Shutting down Guidey API...")


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(ValidationError)
async def validation_error_handler(request: Request, exc: ValidationError):
    return JSONResponse(status_code=400, content={"detail": exc.message})


@app.exception_handler(DomainException)
async def domain_exception_handler(request: Request, exc: DomainException):
    return JSONResponse(status_code=500, content={"detail": exc.message})


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "detail": str(exc) if settings.debug else "Internal server error",
        },
    )


from pathlib import Path
from fastapi.staticfiles import StaticFiles

static_path = Path(settings.static_dir)
if static_path.exists():
    app.mount("/static", StaticFiles(directory=str(static_path)), name="static")

app.include_router(api_router, prefix=settings.api_prefix)


@app.get("/")
async def root():
    return {"message": f"Welcome to {settings.app_name}"}
