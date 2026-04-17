"""ドメイン例外階層.

HTTP 例外 (FastAPI の HTTPException) はルータ層でのみ使う。
ビジネスロジック・インフラ層はこの階層を raise し、main.py のグローバルハンドラが
適切な HTTP ステータスに変換する。
"""


class DomainException(Exception):
    """全ドメイン例外の基底。message は安全にユーザーに返してよい文言を想定。"""

    http_status: int = 500  # 既定: サーバー内部エラー

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class ValidationError(DomainException):
    """入力/コンテキスト検証エラー (400)."""

    http_status = 400


class LLMError(DomainException):
    """LLM 呼び出し失敗 (外部 API 不通、JSON パース不可、schema 違反など)。"""

    http_status = 502  # Bad Gateway: 上流 LLM の問題


class AgentError(DomainException):
    """Graph / Agent 実行時エラー (ノード内部例外、state 不整合など)。"""

    http_status = 500


class SessionError(DomainException):
    """セッション / Checkpointer 関連エラー (存在しない thread_id など)。"""

    http_status = 404
