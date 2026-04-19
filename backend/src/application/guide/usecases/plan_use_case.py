import hashlib
import logging

from src.common.json_utils import extract_json_array
from src.domain.guide.model import RAG_COLLECTIONS, PlanStep, RagResult
from src.domain.guide.service import GuideService
from src.infrastructure.llm.base import LLMClient
from src.infrastructure.rag.embeddings import EmbeddingClient
from src.infrastructure.rag.milvus import MilvusRAGClient

from ..schemas.api import PlanResponse, PlanStepResponse

logger = logging.getLogger(__name__)


class PlanGenerateUseCase:
    def __init__(
        self,
        guide_service: GuideService,
        llm_client: LLMClient,
        rag_client: MilvusRAGClient | None = None,
        embedding_client: EmbeddingClient | None = None,
    ):
        self._guide_service = guide_service
        self._llm_client = llm_client
        self._rag_client = rag_client
        self._embedding_client = embedding_client

    async def generate(self, goal: str, *, session_id: str) -> tuple[PlanResponse, list[PlanStep]]:
        # Multi-Document Synthesis: 全コレクション横断検索
        rag_results = await self._search_rag(goal, top_k=15)
        multi_source_context = await self._build_multi_source_context(rag_results)

        prompt = self._guide_service.build_plan_generation_prompt(
            goal=goal,
            rag_results=rag_results,
            multi_source_context=multi_source_context,
        )

        raw = await self._llm_client.generate_text(prompt)
        logger.info("Plan generation raw output length: %d", len(raw))

        steps = self._parse_steps(raw)
        if not steps:
            steps = [PlanStep(step_number=1, text=goal, visual_marker="作業完了")]

        step_frame_urls = await self._cache_reference_images(steps)

        # state 復元 (GET /plan フォールバック) でも参照画像が効くよう、
        # PlanStep 自体にも frame_path を焼き込む
        for s in steps:
            url = step_frame_urls.get(s.step_number, "")
            if url:
                s.frame_path = url

        source_id = f"generated-{hashlib.md5(goal.encode()).hexdigest()[:8]}"

        response = PlanResponse(
            source_id=source_id,
            title=goal,
            session_id=session_id,
            steps=[
                PlanStepResponse(
                    step_number=s.step_number,
                    text=s.text,
                    visual_marker=s.visual_marker,
                    frame_url=s.frame_path,
                )
                for s in steps
            ],
        )
        return response, steps

    async def _build_multi_source_context(self, rag_results: list[RagResult]) -> str:
        if not rag_results or not self._rag_client:
            return ""

        video_ids = list(dict.fromkeys(r.video_id for r in rag_results if r.video_id))
        if not video_ids:
            return ""

        parts = []
        for vid in video_ids[:5]:
            # 全コレクションから検索
            all_steps = []
            for coll in RAG_COLLECTIONS:
                all_steps.extend(self._rag_client.get_all_steps(collection=coll, video_id=vid))
            if not all_steps:
                continue
            steps_text = "\n".join(
                f"  Step {s.step_number}: {s.text}"
                + (f" [完了基準: {s.visual_marker}]" if s.visual_marker else "")
                for s in all_steps
            )
            parts.append(f"ソース {vid} ({len(all_steps)}ステップ):\n{steps_text}")

        if not parts:
            return ""

        logger.info("Multi-source context: %d sources", len(parts))
        return "\n\n".join(parts)

    async def _cache_reference_images(self, steps: list[PlanStep]) -> dict[int, str]:
        if not self._rag_client or not self._embedding_client or not steps:
            return {}

        result: dict[int, str] = {}
        try:
            texts = [s.text for s in steps]
            embeddings = await self._embedding_client.embed_documents(texts)

            for step, emb in zip(steps, embeddings, strict=False):
                # 全コレクション横断検索
                for coll in RAG_COLLECTIONS:
                    hits = self._rag_client.search(collection=coll, query_embedding=emb, top_k=1)
                    if hits and hits[0].frame_url:
                        result[step.step_number] = hits[0].frame_url
                        break
        except Exception:
            logger.debug("Reference image caching failed", exc_info=True)

        logger.info("Cached reference images for %d/%d steps", len(result), len(steps))
        return result

    async def _search_rag(self, goal: str, top_k: int = 15) -> list[RagResult]:
        if not self._rag_client or not self._embedding_client or not goal:
            return []
        try:
            query_embedding = await self._embedding_client.embed_query(goal)
            # 全コレクション横断検索
            results = []
            for coll in RAG_COLLECTIONS:
                results.extend(
                    self._rag_client.search(collection=coll, query_embedding=query_embedding, top_k=top_k)
                )
            # スコア順にソートして上位を返す
            results.sort(key=lambda r: r.quality_score, reverse=True)
            return results[:top_k]
        except Exception:
            logger.warning("RAG search failed for plan generation", exc_info=True)
            return []

    def _parse_steps(self, raw: str) -> list[PlanStep]:
        data = extract_json_array(raw)
        if data:
            return self._validate_steps(data)
        logger.warning("Failed to parse plan steps: %s", raw[:200])
        return []

    def _validate_steps(self, data: list) -> list[PlanStep]:
        steps = []
        for i, item in enumerate(data):
            if not isinstance(item, dict):
                continue
            steps.append(
                PlanStep(
                    step_number=item.get("step_number", i + 1),
                    text=item.get("text", ""),
                    visual_marker=item.get("visual_marker", ""),
                )
            )
        return steps
