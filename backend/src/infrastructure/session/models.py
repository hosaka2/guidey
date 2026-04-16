"""セッションモデル."""

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Session:
    """1回の作業セッション (プラン開始〜終了)."""

    # --- 識別 ---
    session_id: str
    plan_source_id: str
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())

    # --- プラン ---
    plan_steps: list[dict] = field(default_factory=list)
    total_steps: int = 0

    # --- 進捗 ---
    current_step_index: int = 0
    step_started_at: str = field(default_factory=lambda: datetime.now().isoformat())

    # --- 短期メモリ ---
    recent_observations: list[str] = field(default_factory=list)
    chat_history: list[dict] = field(default_factory=list)

    # --- コスト管理 ---
    total_calls: int = 0
    stage2_calls: int = 0


    MAX_OBSERVATIONS: int = field(default=3, repr=False)
    MAX_CHAT_HISTORY: int = field(default=10, repr=False)

    def add_observation(self, message: str) -> None:
        if not message:
            return
        self.recent_observations.append(message)
        if len(self.recent_observations) > self.MAX_OBSERVATIONS:
            self.recent_observations = self.recent_observations[-self.MAX_OBSERVATIONS:]

    def add_chat_message(self, role: str, content: str) -> None:
        self.chat_history.append({"role": role, "content": content})
        if len(self.chat_history) > self.MAX_CHAT_HISTORY:
            self.chat_history = self.chat_history[-self.MAX_CHAT_HISTORY:]

    def advance_step(self) -> None:
        """ステップ進行。"""
        if self.current_step_index + 1 < self.total_steps:
            self.current_step_index += 1
            self.step_started_at = datetime.now().isoformat()

    def get_step_duration_sec(self) -> int:
        """現在のステップの滞在時間 (秒)."""
        try:
            started = datetime.fromisoformat(self.step_started_at)
            return int((datetime.now() - started).total_seconds())
        except (ValueError, TypeError):
            return 0

    def get_current_step(self) -> dict | None:
        if 0 <= self.current_step_index < len(self.plan_steps):
            return self.plan_steps[self.current_step_index]
        return None

    def get_next_step(self) -> dict | None:
        nxt = self.current_step_index + 1
        if nxt < len(self.plan_steps):
            return self.plan_steps[nxt]
        return None

    def record_call(self, escalated: bool = False) -> None:
        self.total_calls += 1
        if escalated:
            self.stage2_calls += 1

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "plan_source_id": self.plan_source_id,
            "created_at": self.created_at,
            "plan_steps": self.plan_steps,
            "total_steps": self.total_steps,
            "current_step_index": self.current_step_index,
            "step_started_at": self.step_started_at,
            "recent_observations": self.recent_observations,
            "chat_history": self.chat_history,
            "total_calls": self.total_calls,
            "stage2_calls": self.stage2_calls,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Session":
        return cls(
            session_id=data["session_id"],
            plan_source_id=data["plan_source_id"],
            created_at=data.get("created_at", ""),
            plan_steps=data.get("plan_steps", []),
            total_steps=data.get("total_steps", 0),
            current_step_index=data.get("current_step_index", 0),
            step_started_at=data.get("step_started_at", ""),
            recent_observations=data.get("recent_observations", []),
            chat_history=data.get("chat_history", []),
            total_calls=data.get("total_calls", 0),
            stage2_calls=data.get("stage2_calls", 0),
        )
