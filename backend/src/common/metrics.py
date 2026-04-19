"""パイプラインメトリクス (OpenTelemetry ベース).

OTel Meter で Counter / Histogram を定義。
ConsoleExporter で60秒ごとにダンプ + /metrics で JSON 取得可能。
"""

import threading
import time
from collections import deque
from dataclasses import dataclass, field

from src.common.telemetry import get_meter

meter = get_meter("guidey.pipeline")

# === OTel Instruments ===

pipeline_calls = meter.create_counter(
    "pipeline.calls",
    description="Total pipeline invocations",
)

pipeline_escalations = meter.create_counter(
    "pipeline.escalations",
    description="Stage 2 escalation count",
)

pipeline_errors = meter.create_counter(
    "pipeline.errors",
    description="Pipeline error count",
)

pipeline_timeouts = meter.create_counter(
    "pipeline.timeouts",
    description="Pipeline timeout count",
)

pipeline_latency = meter.create_histogram(
    "pipeline.latency_ms",
    description="Pipeline end-to-end latency in milliseconds",
    unit="ms",
)

stage1_latency = meter.create_histogram(
    "pipeline.stage1_latency_ms",
    description="Stage 1 latency in milliseconds",
    unit="ms",
)

stage2_latency = meter.create_histogram(
    "pipeline.stage2_latency_ms",
    description="Stage 2 latency in milliseconds",
    unit="ms",
)


# === /metrics 用の軽量集計 (OTel の ConsoleExporter とは別) ===


@dataclass
class _CallRecord:
    pipeline_type: str
    stage: int
    latency_ms: int
    judgment: str
    escalated: bool
    timestamp: float = field(default_factory=time.time)


class PipelineMetrics:
    """スレッドセーフな集計 (/metrics エンドポイント用)."""

    def __init__(self, window_size: int = 1000):
        self._lock = threading.Lock()
        self._records: deque[_CallRecord] = deque(maxlen=window_size)
        self.total_calls: int = 0
        self.total_stage2_calls: int = 0
        self.total_errors: int = 0
        self.total_timeouts: int = 0

    def record(
        self,
        pipeline_type: str,
        stage: int,
        latency_ms: int,
        judgment: str,
        escalated: bool,
        stage1_ms: int = 0,
        stage2_ms: int = 0,
    ) -> None:
        """パイプライン完了を記録 (OTel + 内部集計)."""
        with self._lock:
            self._records.append(
                _CallRecord(
                    pipeline_type=pipeline_type,
                    stage=stage,
                    latency_ms=latency_ms,
                    judgment=judgment,
                    escalated=escalated,
                )
            )
            self.total_calls += 1
            if escalated:
                self.total_stage2_calls += 1

        # OTel Instruments
        attrs = {"pipeline_type": pipeline_type, "judgment": judgment}
        pipeline_calls.add(1, attrs)
        pipeline_latency.record(latency_ms, attrs)
        if stage1_ms:
            stage1_latency.record(stage1_ms, {"pipeline_type": pipeline_type})
        if escalated:
            pipeline_escalations.add(1, attrs)
            if stage2_ms:
                stage2_latency.record(stage2_ms, {"pipeline_type": pipeline_type})

    def record_error(self) -> None:
        with self._lock:
            self.total_errors += 1
        pipeline_errors.add(1)

    def record_timeout(self) -> None:
        with self._lock:
            self.total_timeouts += 1
        pipeline_timeouts.add(1)

    def is_over_budget(self, max_total: int, max_stage2: int) -> tuple[bool, str]:
        if self.total_calls >= max_total:
            return True, f"total calls {self.total_calls} >= {max_total}"
        if self.total_stage2_calls >= max_stage2:
            return True, f"stage2 calls {self.total_stage2_calls} >= {max_stage2}"
        return False, ""

    def summary(self) -> dict:
        """GET /metrics 用."""
        with self._lock:
            records = list(self._records)

        if not records:
            return {
                "total_calls": self.total_calls,
                "total_stage2_calls": self.total_stage2_calls,
                "total_errors": self.total_errors,
                "total_timeouts": self.total_timeouts,
                "window_size": 0,
            }

        periodic = [r for r in records if r.pipeline_type == "periodic"]
        user_action = [r for r in records if r.pipeline_type == "user_action"]

        def _stats(recs: list[_CallRecord]) -> dict:
            if not recs:
                return {}
            latencies = sorted(r.latency_ms for r in recs)
            n = len(latencies)
            escalated = sum(1 for r in recs if r.escalated)
            judgments: dict[str, int] = {}
            for r in recs:
                judgments[r.judgment] = judgments.get(r.judgment, 0) + 1
            return {
                "count": n,
                "escalation_rate": round(escalated / n, 3),
                "latency_p50": latencies[n // 2],
                "latency_p95": latencies[int(n * 0.95)] if n >= 20 else latencies[-1],
                "latency_avg": round(sum(latencies) / n),
                "judgments": judgments,
            }

        return {
            "total_calls": self.total_calls,
            "total_stage2_calls": self.total_stage2_calls,
            "total_errors": self.total_errors,
            "total_timeouts": self.total_timeouts,
            "window_size": len(records),
            "periodic": _stats(periodic),
            "user_action": _stats(user_action),
        }


# シングルトン
pipeline_metrics = PipelineMetrics()
