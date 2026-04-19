import logging

from pymilvus import CollectionSchema, DataType, FieldSchema, MilvusClient
from pymilvus.milvus_client.index import IndexParams

from src.config import settings
from src.domain.guide.model import RagResult

logger = logging.getLogger(__name__)

EMBEDDING_DIM = 768  # nomic-embed-text


def _build_schema() -> CollectionSchema:
    fields = [
        FieldSchema("id", DataType.INT64, is_primary=True, auto_id=True),
        FieldSchema("video_id", DataType.VARCHAR, max_length=64),
        FieldSchema("step_number", DataType.INT16),
        FieldSchema("total_steps", DataType.INT16),
        FieldSchema("text", DataType.VARCHAR, max_length=2048),
        FieldSchema("frame_path", DataType.VARCHAR, max_length=256),
        FieldSchema("embedding", DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
        # v2 拡張フィールド
        FieldSchema("visual_marker", DataType.VARCHAR, max_length=512),
        FieldSchema("frame_start_path", DataType.VARCHAR, max_length=256),
        FieldSchema("frame_mid_path", DataType.VARCHAR, max_length=256),
        FieldSchema("frame_end_path", DataType.VARCHAR, max_length=256),
        FieldSchema("quality_score", DataType.FLOAT),
        FieldSchema("duration_sec", DataType.FLOAT),
        FieldSchema("frame_caption", DataType.VARCHAR, max_length=2048),
        FieldSchema("caption_embedding", DataType.FLOAT_VECTOR, dim=EMBEDDING_DIM),
    ]
    return CollectionSchema(fields=fields)


# v2 で追加された output_fields
_V2_OUTPUT_FIELDS = [
    "video_id",
    "step_number",
    "total_steps",
    "text",
    "frame_path",
    "visual_marker",
    "frame_start_path",
    "frame_mid_path",
    "frame_end_path",
    "quality_score",
    "duration_sec",
]

# v1 互換 (既存コレクションにv2フィールドがない場合)
_V1_OUTPUT_FIELDS = [
    "video_id",
    "step_number",
    "total_steps",
    "text",
    "frame_path",
]


class MilvusRAGClient:
    """Milvus Lite を使ったベクトル検索クライアント."""

    def __init__(self):
        self._client = MilvusClient(
            uri=settings.milvus_db_path,
            grpc_options={
                "grpc.keepalive_time_ms": 30_000,
                "grpc.keepalive_timeout_ms": 10_000,
            },
        )
        self._fields_cache: dict[str, list[str]] = {}

    def ensure_collection(self, name: str) -> None:
        if not self._client.has_collection(name):
            schema = _build_schema()
            self._client.create_collection(
                collection_name=name,
                schema=schema,
            )
            index_params = IndexParams()
            index_params.add_index(
                field_name="embedding",
                index_type="FLAT",
                metric_type="COSINE",
            )
            index_params.add_index(
                field_name="caption_embedding",
                index_type="FLAT",
                metric_type="COSINE",
            )
            self._client.create_index(
                collection_name=name,
                index_params=index_params,
            )
            logger.info(f"Created collection: {name}")

        self._client.load_collection(name)

    def insert_steps(
        self,
        collection: str,
        video_id: str,
        steps: list[dict],
        embeddings: list[list[float]],
    ) -> int:
        self.ensure_collection(collection)
        data = [
            {
                "video_id": video_id,
                "step_number": step["step_number"],
                "total_steps": step["total_steps"],
                "text": step["text"],
                "frame_path": step.get("frame_path", ""),
                "embedding": emb,
                # v2 フィールド
                "visual_marker": step.get("visual_marker", ""),
                "frame_start_path": step.get("frame_start_path", ""),
                "frame_mid_path": step.get("frame_mid_path", ""),
                "frame_end_path": step.get("frame_end_path", ""),
                "quality_score": step.get("quality_score", 0.5),
                "duration_sec": step.get("duration_sec", 0.0),
                "frame_caption": step.get("frame_caption", ""),
                "caption_embedding": step.get("caption_embedding", [0.0] * EMBEDDING_DIM),
            }
            for step, emb in zip(steps, embeddings, strict=False)
        ]
        result = self._client.insert(collection_name=collection, data=data)
        count = result.get("insert_count", len(data))
        logger.info(f"Inserted {count} steps into {collection}")
        return count

    def _safe_output_fields(self, collection: str) -> list[str]:
        """コレクションが v2 フィールドを持っているか確認 (結果をキャッシュ)."""
        if collection in self._fields_cache:
            return self._fields_cache[collection]
        try:
            info = self._client.describe_collection(collection)
            field_names = {f["name"] for f in info.get("fields", [])}
            fields = _V2_OUTPUT_FIELDS if "visual_marker" in field_names else _V1_OUTPUT_FIELDS
        except Exception:
            fields = _V1_OUTPUT_FIELDS
        self._fields_cache[collection] = fields
        return fields

    def search(
        self,
        collection: str,
        query_embedding: list[float],
        top_k: int = 3,
        field: str = "embedding",
    ) -> list[RagResult]:
        if not self._client.has_collection(collection):
            return []

        output_fields = self._safe_output_fields(collection)

        results = self._client.search(
            collection_name=collection,
            data=[query_embedding],
            anns_field=field,
            limit=top_k,
            output_fields=output_fields,
        )

        if not results or not results[0]:
            return []

        return [self._hit_to_result(hit) for hit in results[0]]

    def get_all_steps(
        self,
        collection: str,
        video_id: str,
    ) -> list[RagResult]:
        """指定 video_id の全ステップを step_number 順で返す."""
        if not self._client.has_collection(collection):
            return []

        output_fields = self._safe_output_fields(collection)

        results = self._client.query(
            collection_name=collection,
            filter=f'video_id == "{video_id}"',
            output_fields=output_fields,
        )

        steps = [
            RagResult(
                video_id=row["video_id"],
                step_number=row["step_number"],
                total_steps=row["total_steps"],
                text=row["text"],
                frame_url=row.get("frame_path", ""),
                visual_marker=row.get("visual_marker", ""),
                quality_score=row.get("quality_score", 0.5),
            )
            for row in results
        ]
        steps.sort(key=lambda s: s.step_number)
        return steps

    def _hit_to_result(self, hit: dict) -> RagResult:
        e = hit["entity"]
        return RagResult(
            video_id=e["video_id"],
            step_number=e["step_number"],
            total_steps=e["total_steps"],
            text=e["text"],
            frame_url=e.get("frame_path", ""),
            visual_marker=e.get("visual_marker", ""),
            quality_score=e.get("quality_score", 0.5),
        )
