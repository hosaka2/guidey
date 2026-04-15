"""UIブロック型定義.

LLMが返す構造化UI要素。モバイルアプリが描画する。
"""

from typing import Literal, Union

from pydantic import BaseModel


class TextBlock(BaseModel):
    type: Literal["text"] = "text"
    content: str
    style: Literal["normal", "emphasis", "warning"] = "normal"


class ImageBlock(BaseModel):
    type: Literal["image"] = "image"
    url: str
    caption: str | None = None


class VideoBlock(BaseModel):
    type: Literal["video"] = "video"
    url: str
    start_sec: float | None = None
    end_sec: float | None = None


class TimerBlock(BaseModel):
    type: Literal["timer"] = "timer"
    duration_sec: int
    label: str


class AlertBlock(BaseModel):
    type: Literal["alert"] = "alert"
    message: str
    severity: Literal["info", "warning", "danger"] = "info"


Block = Union[TextBlock, ImageBlock, VideoBlock, TimerBlock, AlertBlock]
