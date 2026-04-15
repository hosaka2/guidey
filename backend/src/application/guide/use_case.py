import logging
from collections.abc import AsyncIterator

from src.domain.guide.model import GuideMode, RagResult
from src.domain.guide.service import GuideService
from src.infrastructure.llm.base import LLMClient
from src.infrastructure.rag.bm25 import BM25Index
from src.infrastructure.rag.embeddings import EmbeddingClient
from src.infrastructure.rag.hybrid import HybridSearchClient
from src.infrastructure.rag.milvus import MilvusRAGClient

from .schemas import GuideResponse, StepSummary, StreamMeta

logger = logging.getLogger(__name__)


class GuideUseCase:
    def __init__(
        self,
        guide_service: GuideService,
        llm_client: LLMClient,
        rag_client: MilvusRAGClient | None = None,
        embedding_client: EmbeddingClient | None = None,
        hybrid_client: HybridSearchClient | None = None,
    ):
        self._guide_service = guide_service
        self._llm_client = llm_client
        self._rag_client = rag_client
        self._embedding_client = embedding_client
        self._hybrid_client = hybrid_client

    async def _search_rag(
        self, mode: GuideMode, goal: str
    ) -> list[RagResult]:
        if not self._rag_client or not self._embedding_client or not goal:
            return []
        try:
            config = self._guide_service.get_mode_config(mode)
            query_embedding = await self._embedding_client.embed_query(goal)

            # ハイブリッド検索が使えればそちらを使用
            if self._hybrid_client:
                return self._hybrid_client.search(
                    collection=config.collection,
                    query_embedding=query_embedding,
                    query_text=goal,
                )

            # フォールバック: Dense のみ
            return self._rag_client.search(
                collection=config.collection,
                query_embedding=query_embedding,
            )
        except Exception:
            logger.warning("RAG search failed, falling back to no-RAG", exc_info=True)
            return []

    def _build_prompt(
        self,
        mode: GuideMode,
        trigger_word: str,
        goal: str = "",
        rag_results: list[RagResult] | None = None,
    ) -> str:
        config = self._guide_service.get_mode_config(mode)
        return self._guide_service.build_system_prompt(
            config, trigger_word, goal, rag_results
        )

    def _build_meta(
        self, mode: GuideMode, rag_results: list[RagResult]
    ) -> StreamMeta | None:
        if not rag_results:
            return None
        top = rag_results[0]

        # マッチしたソースの全ステップを取得
        all_steps: list[StepSummary] = []
        if self._rag_client and top.video_id:
            config = self._guide_service.get_mode_config(mode)
            full = self._rag_client.get_all_steps(
                collection=config.collection, video_id=top.video_id
            )
            all_steps = [
                StepSummary(
                    step_number=s.step_number,
                    text=s.text,
                    frame_url=s.frame_url,
                )
                for s in full
            ]

        return StreamMeta(
            reference_image_url=top.frame_url,
            current_step=top.step_number,
            total_steps=top.total_steps,
            steps=all_steps,
        )

    async def analyze(
        self, image_bytes: bytes, mode: GuideMode, trigger_word: str, goal: str = ""
    ) -> GuideResponse:
        rag_results = await self._search_rag(mode, goal)
        system_prompt = self._build_prompt(mode, trigger_word, goal, rag_results)
        instruction = await self._llm_client.analyze_image(
            image_bytes=image_bytes,
            system_prompt=system_prompt,
        )
        meta = self._build_meta(mode, rag_results)
        return GuideResponse(
            instruction=instruction,
            mode=mode,
            reference_image_url=meta.reference_image_url if meta else None,
            current_step=meta.current_step if meta else None,
            total_steps=meta.total_steps if meta else None,
        )

    async def analyze_stream(
        self, image_bytes: bytes, mode: GuideMode, trigger_word: str, goal: str = ""
    ) -> tuple[StreamMeta | None, AsyncIterator[str]]:
        rag_results = await self._search_rag(mode, goal)
        system_prompt = self._build_prompt(mode, trigger_word, goal, rag_results)
        meta = self._build_meta(mode, rag_results)

        async def chunks():
            async for chunk in self._llm_client.analyze_image_stream(
                image_bytes=image_bytes,
                system_prompt=system_prompt,
            ):
                yield chunk

        return meta, chunks()
