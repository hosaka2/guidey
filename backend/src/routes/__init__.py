from fastapi import APIRouter

from .guide_router import router as guide_router
from .health_router import router as health_router

api_router = APIRouter()

api_router.include_router(health_router, prefix="/health", tags=["health"])
api_router.include_router(guide_router, prefix="/guide", tags=["guide"])

__all__ = ["api_router"]
