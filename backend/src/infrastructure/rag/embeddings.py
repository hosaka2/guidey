from langchain_ollama import OllamaEmbeddings

from src.config import settings


class EmbeddingClient:
    """nomic-embed-text via Ollama でテキスト埋め込みを生成."""

    def __init__(self):
        self._embeddings = OllamaEmbeddings(
            model=settings.embedding_model,
            base_url=settings.ollama_base_url,
        )

    async def embed_query(self, text: str) -> list[float]:
        return await self._embeddings.aembed_query(text)

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return await self._embeddings.aembed_documents(texts)
