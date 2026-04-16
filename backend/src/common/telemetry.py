"""OpenTelemetry セットアップ.

ゼロインフラ: ConsoleExporter でログに出力。
将来 OTLP に切り替える場合は exporter を差し替えるだけ。

使い方:
  from src.common.telemetry import tracer, meter
  with tracer.start_as_current_span("my_operation") as span:
      span.set_attribute("key", "value")
  counter = meter.create_counter("my_counter")
"""

import logging

from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import (
    ConsoleMetricExporter,
    PeriodicExportingMetricReader,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter

logger = logging.getLogger(__name__)

_RESOURCE = Resource.create({
    "service.name": "guidey-backend",
    "service.version": "0.1.0",
})


def init_telemetry(enable_console: bool = True) -> None:
    """OTel プロバイダー初期化。app 起動時に1回だけ呼ぶ。"""

    # --- Traces ---
    tracer_provider = TracerProvider(resource=_RESOURCE)
    if enable_console:
        tracer_provider.add_span_processor(
            BatchSpanProcessor(ConsoleSpanExporter())
        )
    trace.set_tracer_provider(tracer_provider)

    # --- Metrics ---
    readers = []
    if enable_console:
        readers.append(
            PeriodicExportingMetricReader(
                ConsoleMetricExporter(),
                export_interval_millis=60_000,  # 60秒ごとにコンソール出力
            )
        )
    meter_provider = MeterProvider(resource=_RESOURCE, metric_readers=readers)
    metrics.set_meter_provider(meter_provider)

    logger.info("OpenTelemetry initialized (console=%s)", enable_console)


# --- グローバルアクセス ---
def get_tracer(name: str = "guidey") -> trace.Tracer:
    return trace.get_tracer(name)


def get_meter(name: str = "guidey") -> metrics.Meter:
    return metrics.get_meter(name)
