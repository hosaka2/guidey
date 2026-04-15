"""PlanRepository の ファイルシステム実装."""

import json
from pathlib import Path

from src.domain.guide.model import PlanStep


class FilePlanRepository:
    """static/manual/{source_id}/steps.json からプランを読み込む."""

    def __init__(self, static_dir: str):
        self._base = Path(static_dir) / "manual"

    def _read_json(self, source_id: str) -> dict | None:
        path = self._base / source_id / "steps.json"
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def load(self, source_id: str) -> list[PlanStep] | None:
        data = self._read_json(source_id)
        if not data:
            return None
        return [
            PlanStep(
                step_number=s["step_number"],
                text=s["text"],
                visual_marker=s.get("visual_marker", ""),
                frame_path=s.get("frame", ""),
            )
            for s in data.get("steps", [])
        ]

    def get_title(self, source_id: str) -> str:
        data = self._read_json(source_id)
        return data.get("title", source_id) if data else source_id


# 後方互換: 関数インターフェース (既存の呼び出し元用)
_default: FilePlanRepository | None = None


def _get_default(static_dir: str) -> FilePlanRepository:
    global _default
    if _default is None:
        _default = FilePlanRepository(static_dir)
    return _default


def load_plan(source_id: str, static_dir: str) -> list[PlanStep] | None:
    return _get_default(static_dir).load(source_id)


def get_plan_title(source_id: str, static_dir: str) -> str:
    return _get_default(static_dir).get_title(source_id)
