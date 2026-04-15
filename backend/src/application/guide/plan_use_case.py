import hashlib
import logging

from src.common.json_utils import extract_json_array
from src.domain.guide.model import GuideMode, PlanStep, RagResult
from src.domain.guide.service import GuideService
from src.infrastructure.llm.base import LLMClient
from src.infrastructure.rag.embeddings import EmbeddingClient
from src.infrastructure.rag.milvus import MilvusRAGClient

from .schemas import PlanResponse, PlanStepResponse

logger = logging.getLogger(__name__)

# メモリキャッシュ (サーバー再起動でクリア)
_plan_cache: dict[str, PlanResponse] = {}
# 生成プランのステップを source_id で引けるキャッシュ (judge_use_case 用)
_generated_steps_cache: dict[str, list[PlanStep]] = {}


def get_generated_steps(source_id: str) -> list[PlanStep] | None:
    """生成済みプランをキャッシュから取得 (judge_use_case から呼ばれる)."""
    return _generated_steps_cache.get(source_id)


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

    async def generate(self, goal: str, mode: GuideMode) -> PlanResponse:
        # キャッシュチェック
        cache_key = self._cache_key(goal, mode)
        if cache_key in _plan_cache:
            logger.info("Plan cache hit: %s", cache_key)
            return _plan_cache[cache_key]

        # Multi-Document Synthesis: 複数ソースからステップ候補を収集
        rag_results = await self._search_rag(mode, goal, top_k=15)
        multi_source_context = await self._build_multi_source_context(mode, rag_results)

        # プロンプト構築 (複数ソース統合)
        prompt = self._guide_service.build_plan_generation_prompt(
            goal=goal,
            mode=mode,
            rag_results=rag_results,
            multi_source_context=multi_source_context,
        )

        # LLM呼び出し (テキスト生成)
        raw = await self._llm_client.generate_text(prompt)
        logger.info("Plan generation raw output length: %d", len(raw))

        # JSON解析
        steps = self._parse_steps(raw)
        if not steps:
            # フォールバック: 1ステップだけ返す
            steps = [
                PlanStep(
                    step_number=1,
                    text=goal,
                    visual_marker="作業完了",
                )
            ]

        # 各ステップにお手本画像を事前キャッシュ
        step_frame_urls = await self._cache_reference_images(steps, mode)

        # source_id 生成
        source_id = f"generated-{hashlib.md5(f'{goal}:{mode}'.encode()).hexdigest()[:8]}"

        response = PlanResponse(
            source_id=source_id,
            title=goal,
            steps=[
                PlanStepResponse(
                    step_number=s.step_number,
                    text=s.text,
                    visual_marker=s.visual_marker,
                    frame_url=step_frame_urls.get(s.step_number, ""),
                )
                for s in steps
            ],
        )

        # キャッシュ保存
        _plan_cache[cache_key] = response
        _generated_steps_cache[source_id] = steps

        return response

    async def _build_multi_source_context(
        self, mode: GuideMode, rag_results: list[RagResult]
    ) -> str:
        """複数ソース (video_id) のステップを構造的にまとめる."""
        if not rag_results or not self._rag_client:
            return ""

        config = self._guide_service.get_mode_config(mode)

        # video_id ごとにグルーピング
        video_ids = list(dict.fromkeys(r.video_id for r in rag_results if r.video_id))
        if not video_ids:
            return ""

        parts = []
        for vid in video_ids[:5]:  # 最大5ソース
            all_steps = self._rag_client.get_all_steps(
                collection=config.collection, video_id=vid
            )
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

        logger.info(f"Multi-source context: {len(parts)} sources")
        return "\n\n".join(parts)

    async def _cache_reference_images(
        self, steps: list[PlanStep], mode: GuideMode
    ) -> dict[int, str]:
        """各ステップのテキストでRAG検索し、最も近いお手本画像のURLを返す。バッチ埋め込み。"""
        if not self._rag_client or not self._embedding_client or not steps:
            return {}

        config = self._guide_service.get_mode_config(mode)
        result: dict[int, str] = {}

        try:
            # バッチ埋め込み (N+1 → 1回のAPI呼び出し)
            texts = [s.text for s in steps]
            embeddings = await self._embedding_client.embed_documents(texts)

            for step, emb in zip(steps, embeddings):
                hits = self._rag_client.search(
                    collection=config.collection,
                    query_embedding=emb,
                    top_k=1,
                )
                if hits and hits[0].frame_url:
                    result[step.step_number] = hits[0].frame_url
        except Exception:
            logger.debug("Reference image caching failed", exc_info=True)

        logger.info("Cached reference images for %d/%d steps", len(result), len(steps))
        return result

    async def _search_rag(
        self, mode: GuideMode, goal: str, top_k: int = 15
    ) -> list[RagResult]:
        if not self._rag_client or not self._embedding_client or not goal:
            return []
        try:
            config = self._guide_service.get_mode_config(mode)
            query_embedding = await self._embedding_client.embed_query(goal)
            return self._rag_client.search(
                collection=config.collection,
                query_embedding=query_embedding,
                top_k=top_k,
            )
        except Exception:
            logger.warning("RAG search failed for plan generation", exc_info=True)
            return []

    def _parse_steps(self, raw: str) -> list[PlanStep]:
        """LLM出力からPlanStepリストを解析."""
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

    def _cache_key(self, goal: str, mode: GuideMode) -> str:
        return f"{mode.value}:{goal.strip().lower()}"
