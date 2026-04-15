"""週次フィードバック → RAGスコア反映バッチ.

使い方:
    uv run python -m scripts.feedback_batch

フィードバックテーブルの集計結果をMilvusのquality_scoreに反映する。
- negative 2回以上 → スコア -0.1 × n
- plan_retry 関連 → スコア -0.2
"""

import asyncio
import logging

from src.infrastructure.repositories.feedback_repository import SqliteFeedbackRepository
from src.infrastructure.rag.milvus import MilvusRAGClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


async def main():
    logger.info("=== 週次フィードバック反映バッチ ===")

    repo = SqliteFeedbackRepository()

    # 1. フィードバック集計
    summary = repo.get_summary(days=7)
    if not summary:
        logger.info("直近7日のフィードバックなし。終了。")
        return

    logger.info("フィードバック集計:")
    for row in summary:
        logger.info(f"  {row['target_type']}/{row['sentiment']}: {row['count']}件")

    # 2. 負フィードバックの多いチャンク
    negative_chunks = repo.get_negative_chunks(days=7, min_count=2)
    if not negative_chunks:
        logger.info("スコア更新対象のチャンクなし。")
        return

    logger.info(f"スコア更新対象: {len(negative_chunks)} チャンク")

    # 3. TODO: Milvus のスコア更新
    # 現在の Milvus Lite は update が制限されているため、
    # 将来的に再インデックスまたは Milvus Standalone で対応
    for chunk in negative_chunks:
        logger.info(f"  chunk={chunk['chunk_id']} negative={chunk['negative_count']}回 → スコア降格候補")

    logger.info("=== バッチ完了 ===")


if __name__ == "__main__":
    asyncio.run(main())
