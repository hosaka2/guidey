from langchain_ollama import ChatOllama

from src.config import settings
from src.infrastructure.llm.base import BaseLangChainClient


class OllamaClient(BaseLangChainClient):
    """高速版: 自律判定、リアルタイム解析用 (e2b, think=False, 4K ctx)."""

    def __init__(self):
        self._model = ChatOllama(
            model=settings.ollama_model,
            base_url=settings.ollama_base_url,
            num_ctx=4096,
            think=False,
        )


class OllamaHQClient(BaseLangChainClient):
    """高品質版: RAG作成、プラン生成など精度重視.

    将来 gemma4:26b (think=True, 32K ctx) or Claude に切り替え。
    現在はローカルリソース節約のため e2b (think=False) で代用。
    """

    def __init__(self):
        self._model = ChatOllama(
            model=settings.ollama_hq_model,
            base_url=settings.ollama_base_url,
            num_ctx=4096,
            think=False,
        )
