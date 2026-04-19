from src.config import settings
from src.infrastructure.llm.base import LLMClient


def get_llm_client() -> LLMClient:
    """高速版: リアルタイム判定、ストリーミング解析用."""
    if settings.llm_provider == "anthropic":
        from src.infrastructure.llm.claude import ClaudeClient

        return ClaudeClient()

    from src.infrastructure.llm.ollama import OllamaClient

    return OllamaClient()


def get_hq_llm_client() -> LLMClient:
    """高品質版: Stage 2 エスカレーション、RAG作成、プラン生成.

    hq_provider が設定されていればそちらを優先。
    未設定なら llm_provider にフォールバック。
    """
    provider = settings.hq_provider or settings.llm_provider

    if provider == "anthropic":
        from src.infrastructure.llm.claude import ClaudeClient

        return ClaudeClient()

    from src.infrastructure.llm.ollama import OllamaHQClient

    return OllamaHQClient()
