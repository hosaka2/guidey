"""BM25 スパース検索インデックス."""

import logging
import re

from rank_bm25 import BM25Okapi

from src.domain.guide.model import RagResult

logger = logging.getLogger(__name__)


def _tokenize_ja(text: str) -> list[str]:
    """簡易日本語トークナイザ（文字ベース bi-gram + 単語区切り）."""
    # 句読点・記号を除去
    text = re.sub(r"[、。！？\s\n]+", " ", text)
    words = text.strip().split()
    # 各単語を bi-gram に分解 (日本語は形態素解析なしでbi-gramが有効)
    tokens = []
    for w in words:
        if len(w) <= 2:
            tokens.append(w)
        else:
            for i in range(len(w) - 1):
                tokens.append(w[i : i + 2])
    return tokens


class BM25Index:
    """インメモリ BM25 インデックス."""

    def __init__(self):
        self._corpus: list[list[str]] = []
        self._results: list[RagResult] = []
        self._bm25: BM25Okapi | None = None

    def build(self, results: list[RagResult]) -> None:
        """RagResult リストからインデックスを構築."""
        self._results = results
        self._corpus = [_tokenize_ja(r.text) for r in results]
        if self._corpus:
            self._bm25 = BM25Okapi(self._corpus)
        else:
            self._bm25 = None
        logger.info("BM25 index built with %d documents", len(self._corpus))

    def search(self, query: str, top_k: int = 5) -> list[tuple[RagResult, float]]:
        """BM25 検索。(result, score) のリストを返す."""
        if not self._bm25 or not self._corpus:
            return []

        tokens = _tokenize_ja(query)
        scores = self._bm25.get_scores(tokens)

        # スコア付きでソート
        scored = sorted(
            zip(self._results, scores, strict=False),
            key=lambda x: x[1],
            reverse=True,
        )
        return scored[:top_k]
