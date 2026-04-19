"""SSE / form-data で送受信する型を OpenAPI spec に露出させるためのスキーマ.

FastAPI は JSON ボディを持たない form-data / SSE の中身を自動で OpenAPI に含めないので、
`/schemas` ダミーエンドポイントで response_model に載せてクライアント側の
openapi-typescript 生成時に拾えるようにする。

モバイル側はこれらの型を `lib/api/schema.ts` から自動生成して使う。
"""

from typing import Literal

from pydantic import BaseModel

from src.application.guide.schemas.outputs import Stage1Output


class StageEvent(BaseModel):
    """/periodic / /chat の SSE `event: stage` ペイロード。"""

    stage: Literal[1, 2]
    judgment: str  # "continue" | "next" | "anomaly" | "calibrated"
    confidence: float
    message: str
    blocks: list[dict]  # Block (Text/Image/Video/Timer/Alert) の discriminated union
    escalated: bool
    current_step_index: int | None = None


class SchemaExports(BaseModel):
    """クライアント型生成用の束ね箱。中身は使わず、OpenAPI に型を載せるだけ。"""

    stage1: Stage1Output
    stage_event: StageEvent
