"""ハイブリッド検索: Dense (Milvus) + Sparse (BM25) を RRF で統合."""

import logging

from src.domain.guide.model import RagResult

from .bm25 import BM25Index
from .milvus import MilvusRAGClient

logger = logging.getLogger(__name__)

# RRF (Reciprocal Rank Fusion) の定数
RRF_K = 60


def reciprocal_rank_fusion(
    ranked_lists: list[list[RagResult]],
    k: int = RRF_K,
) -> list[RagResult]:
    """複数のランク付きリストを RRF で統合."""
    scores: dict[str, float] = {}
    result_map: dict[str, RagResult] = {}

    for ranked in ranked_lists:
        for rank, result in enumerate(ranked):
            key = f"{result.video_id}:{result.step_number}"
            scores[key] = scores.get(key, 0) + 1.0 / (k + rank + 1)
            result_map[key] = result

    sorted_keys = sorted(scores, key=lambda k: scores[k], reverse=True)
    return [result_map[k] for k in sorted_keys]


class HybridSearchClient:
    """Dense + BM25 のハイブリッド検索."""

    def __init__(
        self,
        milvus_client: MilvusRAGClient,
        bm25_index: BM25Index,
    ):
        self._milvus = milvus_client
        self._bm25 = bm25_index

    def search(
        self,
        collection: str,
        query_embedding: list[float],
        query_text: str,
        top_k: int = 5,
    ) -> list[RagResult]:
        """Dense + BM25 → RRF で統合."""
        # 1. Dense 検索 (Milvus)
        dense_results = self._milvus.search(
            collection=collection,
            query_embedding=query_embedding,
            top_k=top_k * 2,
        )

        # 2. BM25 検索
        bm25_scored = self._bm25.search(query_text, top_k=top_k * 2)
        bm25_results = [r for r, _ in bm25_scored]

        # 3. RRF 統合
        if not bm25_results:
            # BM25 インデックスが空なら Dense のみ
            return dense_results[:top_k]

        fused = reciprocal_rank_fusion([dense_results, bm25_results])
        logger.info(
            "Hybrid search: dense=%d, bm25=%d, fused=%d",
            len(dense_results),
            len(bm25_results),
            len(fused),
        )
        return fused[:top_k]
