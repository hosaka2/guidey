"""ユーザー対話ユースケース (/guide/chat).

2段階LLM:
  Stage 1 (fast): 即応答を試みる。簡単な質問・ツール実行はここで完結。
  Stage 2 (deep): エスカレーション時のみ。複雑な判断、RAG検索、プラン修正。
"""

import logging

from src.common.json_utils import extract_json_object
from src.domain.guide.model import PlanStep
from src.domain.guide.service import GuideService
from src.infrastructure.agent.tools import GEMMA_TOOLS, build_hq_tools
from src.infrastructure.llm.base import LLMClient
from src.infrastructure.rag.embeddings import EmbeddingClient
from src.infrastructure.rag.milvus import MilvusRAGClient

logger = logging.getLogger(__name__)


# === Stage 1 プロンプト ===

STAGE1_SYSTEM = """あなたはハンズフリー作業サポートエージェントの1段目です。
ユーザーの発話に対して、可能な限り自分で即座に応答してください。

## あなたができること
- 簡単な質問に即答（「火加減は？」「あと何分？」「これでいい？」）
- ツール実行（タイマーセット、警告表示、テキスト表示、画像表示）
- 励まし、共感（「疲れた」「不安」→ 温かく1文で）
- 現在のステップに関する情報提供

## エスカレーション基準（自分で処理せず2段目に任せる）
以下に該当する場合は can_handle: false にしてください:
- プラン全体の変更が必要（「醤油切らした」「カレーに変更」）
- 複数の選択肢から提案が必要
- 安全に関わる重要判断（「これ生焼け？」「ガス臭い」）
- 自分の知識で答えに自信がない
- RAGデータベースの検索が必要
**迷ったらエスカレーションしてください。間違った応答より、2段目に任せる方がユーザーのためです。**

## 応答ルール
- 1〜2文で簡潔に
- 現在のステップの文脈を踏まえる（一般論NG）
- 分からないことは「分かりません」と素直に
- 料理/DIYと無関係な質問は「作業に集中しますね」と丁寧に断る

## 出力形式（必ずJSONのみ）
通常: {"message": "応答テキスト", "can_handle": true}
エスカレーション: {"message": "", "can_handle": false, "escalation_reason": "理由"}
"""

STAGE2_SYSTEM = """あなたはハンズフリー作業サポートエージェントの2段目（高精度）です。
1段目が自信なしでエスカレーションしました。丁寧に、正確に応答してください。

## あなたができること（1段目より高度）
- RAGデータベース検索（関連レシピ、手順、代替案の調査）
- プランのステップ修正（材料代替、手順変更）
- 複数の選択肢を提示して質問
- 安全に関わる判断（慎重に、「分からなければ分からない」と言う）

## 応答ルール
- 状況を踏まえて具体的に回答
- 選択肢がある場合は2〜3個に絞って提示
- 安全に関わる場合は必ず「確認してください」と付ける
- 推測は「〜だと思います」と明示

## 出力形式（必ずJSONのみ）
{"message": "応答テキスト"}
"""


class ChatUseCase:
    def __init__(
        self,
        guide_service: GuideService,
        llm_client: LLMClient,
        hq_client: LLMClient | None = None,
        rag_client: MilvusRAGClient | None = None,
        embedding_client: EmbeddingClient | None = None,
    ):
        self._guide_service = guide_service
        self._llm = llm_client
        self._hq = hq_client or llm_client
        self._rag = rag_client
        self._emb = embedding_client

    async def chat(
        self,
        user_message: str,
        image_bytes: bytes | None = None,
        current_step: PlanStep | None = None,
        next_step: PlanStep | None = None,
        recent_observations: list[str] | None = None,
        plan_steps: list[PlanStep] | None = None,
    ) -> dict:
        """ユーザー発話に応答。戻り値: {message, blocks, escalated}"""

        context = self._build_context(current_step, next_step, recent_observations)
        prompt = f"{STAGE1_SYSTEM}\n{context}\nユーザー: 「{user_message}」"

        logger.info("[Chat Stage1] user='%s' step=%s",
                    user_message[:30], current_step.step_number if current_step else "-")

        # Stage 1: fast LLM + tool calling
        try:
            text, tool_results = await self._llm.call_with_tools(
                system_prompt=prompt, tools=GEMMA_TOOLS,
                image_bytes=image_bytes, max_rounds=3,
            )
            if tool_results:
                logger.info("[Chat Stage1] tools: %s", [r.get("type") for r in tool_results])

            parsed = extract_json_object(text) or {}
            can_handle = parsed.get("can_handle", True)

            if not can_handle:
                reason = parsed.get("escalation_reason", "")
                logger.info("[Chat Stage1] → escalate: %s", reason[:50])
                return await self._stage2(
                    user_message, image_bytes, current_step, next_step,
                    recent_observations, plan_steps, reason,
                )

            message = parsed.get("message", text or "")
            logger.info("[Chat Stage1] → respond: '%s' blocks=%d", message[:40], len(tool_results))
            return {"message": message, "blocks": tool_results, "escalated": False}

        except Exception as e:
            logger.info("[Chat Stage1] tool calling failed (%s), text fallback", e)
            if image_bytes:
                raw = await self._llm.analyze_image(image_bytes, prompt)
            else:
                raw = await self._llm.generate_text(prompt)
            parsed = extract_json_object(raw) or {}
            return {
                "message": parsed.get("message", raw),
                "blocks": [],
                "escalated": False,
            }

    async def _stage2(
        self, user_message, image_bytes, current_step, next_step,
        recent_observations, plan_steps, escalation_reason,
    ) -> dict:
        """Stage 2: deep LLM + 拡張ツール."""
        context = self._build_context(current_step, next_step, recent_observations)
        prompt = (
            f"{STAGE2_SYSTEM}\n"
            f"エスカレーション理由: {escalation_reason}\n"
            f"{context}\n"
            f"ユーザー: 「{user_message}」"
        )

        hq_tools = build_hq_tools(
            rag_client=self._rag,
            embedding_client=self._emb,
            plan_steps_ref=list(plan_steps or []),
        )

        logger.info("[Chat Stage2] reason='%s'", escalation_reason[:50])

        try:
            text, tool_results = await self._hq.call_with_tools(
                system_prompt=prompt, tools=hq_tools,
                image_bytes=image_bytes, max_rounds=5,
            )
            if tool_results:
                logger.info("[Chat Stage2] tools: %s", [r.get("type") for r in tool_results])

            parsed = extract_json_object(text) or {}
            message = parsed.get("message", text or "")
            logger.info("[Chat Stage2] → respond: '%s' blocks=%d", message[:40], len(tool_results))
            return {"message": message, "blocks": tool_results, "escalated": True}

        except Exception as e:
            logger.warning("[Chat Stage2] failed: %s", e)
            return {
                "message": "すみません、うまく応答できませんでした",
                "blocks": [],
                "escalated": True,
            }

    def _build_context(self, current_step, next_step, recent_observations) -> str:
        """共通コンテキスト（ステップ情報 + 直近の観察）."""
        parts = []
        if current_step:
            parts.append(f"現在のステップ (Step {current_step.step_number}): {current_step.text}")
            if current_step.visual_marker:
                parts.append(f"完了の目印: {current_step.visual_marker}")
        if next_step:
            parts.append(f"次のステップ: {next_step.text}")
        if recent_observations:
            parts.append("直近の対話:")
            for obs in (recent_observations or [])[-3:]:
                parts.append(f"  - {obs}")
        return "\n".join(parts) if parts else "(コンテキストなし)"
