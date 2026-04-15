from langchain_anthropic import ChatAnthropic

from src.config import settings
from src.infrastructure.llm.base import BaseLangChainClient


class ClaudeClient(BaseLangChainClient):
    def __init__(self):
        self._model = ChatAnthropic(
            model=settings.anthropic_model,
            api_key=settings.anthropic_api_key,
        )
