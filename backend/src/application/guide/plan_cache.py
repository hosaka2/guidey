"""プラン用インメモリキャッシュ (サーバ再起動でクリア)。

プラン生成は重いので goal → PlanResponse を保持し、再計算を避ける。
生成済みプランのステップ (PlanStep オブジェクト) は source_id 別に別キャッシュ。

将来 Redis 等に移行するときのための、単一窓口 (モジュール関数) を提供。
"""

from src.application.guide.schemas import PlanResponse
from src.domain.guide.model import PlanStep

# goal (lowercased, stripped) → PlanResponse
_plan_cache: dict[str, PlanResponse] = {}
# source_id → PlanStep リスト (生成プランのみ、既存プランは plan_repository から読む)
_generated_steps_cache: dict[str, list[PlanStep]] = {}


def get_by_goal(goal: str) -> PlanResponse | None:
    return _plan_cache.get(_normalize(goal))


def get_by_source_id(source_id: str) -> PlanResponse | None:
    """source_id で直接引ける (plan_query_use_case が使う)。"""
    for p in _plan_cache.values():
        if p.source_id == source_id:
            return p
    return None


def put(goal: str, response: PlanResponse, steps: list[PlanStep]) -> None:
    _plan_cache[_normalize(goal)] = response
    _generated_steps_cache[response.source_id] = steps


def get_generated_steps(source_id: str) -> list[PlanStep] | None:
    return _generated_steps_cache.get(source_id)


def _normalize(goal: str) -> str:
    return goal.strip().lower()
