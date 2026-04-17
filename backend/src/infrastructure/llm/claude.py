from langchain_anthropic import ChatAnthropic

from src.config import settings
from src.infrastructure.llm.base import BaseLangChainClient


class ClaudeClient(BaseLangChainClient):
    """Anthropic Claude クライアント。

    Prompt Caching を有効化: system_prompt (通常長い) に cache_control を付けて、
    同一 prompt の再送時にキャッシュヒット分のコストを削減する。
    Stage2 の escalation prompt 等、繰り返し同じテキストを送るパスで効く。
    """

    _supports_prompt_caching = True

    def __init__(self):
        self._model = ChatAnthropic(
            model=settings.anthropic_model,
            api_key=settings.anthropic_api_key,
        )
