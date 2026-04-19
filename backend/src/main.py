import logging
import warnings
from contextlib import asynccontextmanager

# milvus-lite が内部で deprecated な pkg_resources を使っている (upstream未修正)
warnings.filterwarnings("ignore", message="pkg_resources is deprecated", category=UserWarning)

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .common.exceptions import DomainException
from .config import settings
from .routes import api_router


# === Logger 統一フォーマット ===
def _setup_logging() -> None:
    fmt = "[%(asctime)s] %(levelname)-5s %(name)s | %(message)s"
    datefmt = "%H:%M:%S"
    logging.basicConfig(level=logging.INFO, format=fmt, datefmt=datefmt, force=True)
    # ライブラリのログを抑制
    for noisy in ("httpx", "httpcore", "urllib3", "pymilvus", "opentelemetry"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


_setup_logging()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # === OpenTelemetry 初期化 ===
    from .common.telemetry import init_telemetry

    init_telemetry(enable_console=settings.debug)

    logger.info("Starting Guidey API...")
    # パーソナライズDB初期化
    from .infrastructure.repositories.feedback_repository import init_db

    try:
        init_db()
    except Exception:
        logger.warning("Failed to init personalization DB", exc_info=True)

    # Checkpointer (AsyncRedisSaver) 初期化 + インデックス作成
    from .application.dependencies import get_checkpointer

    try:
        await get_checkpointer()
        logger.info("Redis checkpointer ready (%s)", settings.redis_url)
    except Exception:
        logger.warning(
            "Checkpointer init failed — sessions will not persist",
            exc_info=True,
        )

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


@app.exception_handler(DomainException)
async def domain_exception_handler(request: Request, exc: DomainException):
    # http_status は各例外クラスで定義 (ValidationError=400, LLMError=502, ...)
    return JSONResponse(status_code=exc.http_status, content={"detail": exc.message})


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


@app.get("/metrics")
async def metrics():
    """パイプラインメトリクス (インメモリ、dev/LT用)."""
    from .common.metrics import pipeline_metrics

    return pipeline_metrics.summary()
