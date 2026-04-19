"""LLM 出力の構造化スキーマ (Structured Output 用)."""

from typing import Literal

from pydantic import BaseModel, Field


class Stage1Output(BaseModel):
    """Stage 1 (fast judgment) 構造化出力."""

    judgment: Literal["continue", "next", "anomaly"] = Field(
        default="continue",
        description="continue: 変化なし, next: ステップ進行, anomaly: 異常検知",
    )
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    message: str = Field(default="", description="ユーザーへの応答。不要なら空文字。")
    can_handle: bool = Field(
        default=True,
        description="Stage1 で完結できるか。False なら Stage2 にエスカレーション。",
    )
    escalation_reason: str = Field(
        default="",
        description="can_handle=False の場合の理由 (Stage2 が参照)。",
    )


class Stage2Output(BaseModel):
    """Stage 2 (deep + tools) 構造化最終出力."""

    judgment: Literal["continue", "next", "anomaly"] = Field(
        default="continue",
    )
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    message: str = Field(default="", description="ユーザーへの応答。")


class CalibrationOutput(BaseModel):
    """キャリブレーション出力: 開始ステップ推定."""

    step_number: int = Field(default=1, ge=1, description="開始ステップ番号 (1始まり)")
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)
    message: str = Field(default="", description="判定理由の補足")
