"""Valkey (Redis互換) セッションストア."""

import json
import logging
import uuid

import redis.asyncio as redis

from src.config import settings
from src.infrastructure.session.models import Session

logger = logging.getLogger(__name__)


class ValkeySessionStore:
    """非同期 Valkey セッション管理。"""

    def __init__(self, url: str | None = None, ttl: int | None = None):
        self._url = url or settings.redis_url
        self._ttl = ttl or settings.session_ttl_sec
        self._redis: redis.Redis | None = None

    async def _get_client(self) -> redis.Redis:
        if self._redis is None:
            self._redis = redis.from_url(self._url, decode_responses=True)
        return self._redis

    def _key(self, session_id: str) -> str:
        return f"session:{session_id}"

    def _pending_key(self, session_id: str) -> str:
        return f"pending:{session_id}"

    async def create(self, plan_source_id: str, plan_steps: list[dict]) -> Session:
        """新規セッション作成。"""
        session = Session(
            session_id=str(uuid.uuid4()),
            plan_source_id=plan_source_id,
            plan_steps=plan_steps,
            total_steps=len(plan_steps),
        )
        client = await self._get_client()
        await client.set(
            self._key(session.session_id),
            json.dumps(session.to_dict(), ensure_ascii=False),
            ex=self._ttl,
        )
        logger.info("[Session] created %s plan=%s steps=%d", session.session_id[:8], plan_source_id, len(plan_steps))
        return session

    async def get(self, session_id: str) -> Session | None:
        """セッション取得 + TTL リセット。"""
        client = await self._get_client()
        key = self._key(session_id)
        data = await client.get(key)
        if not data:
            return None
        # TTL リセット (アクティブなセッションは延命)
        await client.expire(key, self._ttl)
        return Session.from_dict(json.loads(data))

    async def save(self, session: Session) -> None:
        """セッション更新。"""
        client = await self._get_client()
        await client.set(
            self._key(session.session_id),
            json.dumps(session.to_dict(), ensure_ascii=False),
            ex=self._ttl,
        )

    async def delete(self, session_id: str) -> None:
        """セッション削除。"""
        client = await self._get_client()
        await client.delete(self._key(session_id))
        logger.info("[Session] deleted %s", session_id[:8])

    # === Pending (Stage 2 バックグラウンド結果、session 本体とは独立) ===

    async def set_pending(self, session_id: str, message: str, blocks: list[dict]) -> None:
        """bg task が Stage 2 結果を書き込む。session 本体に触らない。"""
        client = await self._get_client()
        data = json.dumps({"message": message, "blocks": blocks}, ensure_ascii=False)
        await client.set(self._pending_key(session_id), data, ex=60)  # 60秒で揮発
        logger.info("[Session] pending set %s msg='%s' blocks=%d", session_id[:8], message[:30], len(blocks))

    async def drain_pending(self, session_id: str) -> tuple[str, list[dict]]:
        """pending を取得+削除 (アトミック)。なければ空を返す。"""
        client = await self._get_client()
        key = self._pending_key(session_id)
        # GETDEL: 取得と同時に削除 (Redis 6.2+ / Valkey 対応)
        data = await client.getdel(key)
        if not data:
            return "", []
        parsed = json.loads(data)
        msg = parsed.get("message", "")
        blocks = parsed.get("blocks", [])
        logger.info("[Session] pending drained %s msg='%s' blocks=%d", session_id[:8], msg[:30], len(blocks))
        return msg, blocks

    async def close(self) -> None:
        if self._redis:
            await self._redis.aclose()
            self._redis = None
