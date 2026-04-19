"""Guide Agent の LangGraph StateGraph.

エージェント全体を単一の StateGraph で宣言的に記述する。

  START → entry (router)
          ├─ is_calibration=True       → calibrate ─────────────► END
          ├─ precomputed_stage1 あり   → seed_stage1 ──┐          (エッジ stage1 経路)
          └─ 通常                       → stage1 ─────┤
                                                       ↓
                                             (escalated?)
                                             ├─ yes → stage2 ──┐
                                             └─ no  ──┐        ↓
                                                      └──► safety ──► END

ノード:
  - stage1:       cloud 推論 (call_structured: Stage1Output)
  - seed_stage1:  client 持ち込み結果を state に hydrate (エッジ推論対応)
  - stage2:       create_react_agent + Stage2Output + tool artifact
  - safety:       安全ガード + session メモリ更新 + 最終 SSE emit
  - calibrate:    初期位置推定 (call_structured: CalibrationOutput)

永続化 (Checkpointer):
  plan_steps / current_step_index / step_started_at / chat_history /
  recent_observations / total_calls / stage2_calls は graph state に入り
  AsyncRedisSaver が thread_id (= session_id) ごとに自動保存する。

per-call inputs:
  image_bytes / user_message / is_calibration / precomputed_stage1 は
  config["configurable"] で渡す (state に入れない = checkpoint に残らない)。
  → 画像 bytes が Redis に焼き付かない / 次セッションで混ざらない。
"""

import logging
import time
from datetime import datetime
from typing import TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.graph.state import CompiledStateGraph

from src.application.guide.schemas.blocks import AlertBlock
from src.application.guide.schemas.outputs import CalibrationOutput, Stage1Output, Stage2Output
from src.domain.guide.model import PlanStep, check_step_safety
from src.domain.guide.service import GuideService
from src.infrastructure.agent.tools import build_hq_tools
from src.infrastructure.llm.base import LLMClient
from src.infrastructure.rag.embeddings import EmbeddingClient
from src.infrastructure.rag.milvus import MilvusRAGClient

logger = logging.getLogger(__name__)


# ============================================================================
# State (Checkpointer が永続化する部分)
# ============================================================================


class GuideGraphState(TypedDict, total=False):
    """Checkpointer で thread_id ごとに永続化される state。

    image_bytes / user_message / is_calibration / precomputed_stage1 / pipeline_type は
    入れない (毎回 config から受け取る一時入力)。
      - pipeline_type が per-call な理由: 同一セッションで /periodic と
        /chat (user_action) を交互に呼びたいため、永続化するとプロンプト選択が壊れる
    """

    # --- セッションメタデータ (初回に /plan/{id} が seed する) ---
    plan_steps: list[dict]  # [{step_number, text, visual_marker, frame_path}]
    plan_source_id: str
    plan_title: str  # タイトル (生成プランは SQLite 非永続なので state に保持)
    total_steps: int

    # --- 進捗 (変化する) ---
    current_step_index: int
    step_started_at: str  # ISO datetime、next 判定時に更新

    # --- 短期メモリ ---
    recent_observations: list[str]  # 直近 3 件 (safety ノードで append)
    chat_history: list[dict]  # 直近 10 件 [{role, content}]

    # --- コスト管理 ---
    total_calls: int
    stage2_calls: int

    # --- ノード出力スナップショット (毎ターン上書き) ---
    stage1: dict | None  # Stage1Output.model_dump()
    stage2: dict | None  # Stage2Output.model_dump()
    escalated: bool
    judgment: str
    confidence: float
    message: str
    blocks: list[dict]


# 短期メモリの上限
MAX_OBSERVATIONS = 3
MAX_CHAT_HISTORY = 10
MIN_STEP_DURATION_SEC = 15


# ============================================================================
# セーフティガード (純関数)
# ============================================================================


def apply_safety(
    *,
    judgment: str,
    confidence: float,
    message: str,
    blocks: list[dict],
    plan_steps: list[PlanStep],
    current_step_index: int,
    current_step_duration_sec: int,
) -> dict:
    """最終判定にセーフティガードを適用。

    1. 次ステップの危険キーワード検知  → AlertBlock + 警告合成 (next は維持)
    2. 最終ステップ超え防止             → continue にダウングレード
    3. 現ステップ滞在 < 15 秒で next   → continue にダウングレード (早押し防止)
    4. 低確信度 (< 0.5) anomaly        → continue にダウングレード

    戻り値: {judgment, confidence, message, blocks, safety_override, safety_reason}
    """
    blocks = list(blocks)

    if judgment == "next":
        next_idx = current_step_index + 1

        # 1. 次ステップに危険キーワードが含まれるか
        if next_idx < len(plan_steps):
            override, warning = check_step_safety(plan_steps[next_idx])
            if override != "none":
                blocks.append(AlertBlock(message=warning, severity="warning").model_dump())
                return {
                    "judgment": judgment,
                    "confidence": confidence,
                    "message": f"{message} ⚠️ {warning}",
                    "blocks": blocks,
                    "safety_override": override,
                    "safety_reason": warning,
                }

        # 2. 既に最終ステップを超えている
        if next_idx >= len(plan_steps):
            logger.info(
                "[safety] next blocked: already at last step (%d/%d)",
                current_step_index + 1,
                len(plan_steps),
            )
            return {
                "judgment": "continue",
                "confidence": confidence,
                "message": "最後のステップです",
                "blocks": blocks,
                "safety_override": "block",
                "safety_reason": "last step",
            }

        # 3. 滞在時間ガード (LLM の誤判定救済)
        if current_step_duration_sec < MIN_STEP_DURATION_SEC:
            logger.info(
                "[safety] next blocked: current step only %ds (min %ds)",
                current_step_duration_sec,
                MIN_STEP_DURATION_SEC,
            )
            return {
                "judgment": "continue",
                "confidence": confidence,
                "message": "",
                "blocks": blocks,
                "safety_override": "block",
                "safety_reason": "min duration",
            }

    if judgment == "anomaly" and confidence < 0.5:
        logger.info("[safety] anomaly blocked: low confidence %.2f", confidence)
        return {
            "judgment": "continue",
            "confidence": confidence,
            "message": "確信度が低いため、もう少し様子を見ます",
            "blocks": blocks,
            "safety_override": "block",
            "safety_reason": "low confidence anomaly",
        }

    return {
        "judgment": judgment,
        "confidence": confidence,
        "message": message,
        "blocks": blocks,
        "safety_override": "none",
        "safety_reason": "",
    }


# ============================================================================
# プロンプト構築ヘルパ
# ============================================================================


def _plan_step_objs(state: GuideGraphState) -> list[PlanStep]:
    """state.plan_steps (list[dict]) を PlanStep に復元。"""
    return [PlanStep(**s) for s in state.get("plan_steps", [])]


def _current_and_next(state: GuideGraphState) -> tuple[PlanStep | None, PlanStep | None]:
    steps = _plan_step_objs(state)
    idx = state.get("current_step_index", 0)
    current = steps[idx] if 0 <= idx < len(steps) else None
    nxt = steps[idx + 1] if idx + 1 < len(steps) else None
    return current, nxt


def _step_duration_sec(state: GuideGraphState) -> int:
    """step_started_at から現ステップの滞在時間 (秒) を計算。"""
    try:
        started = datetime.fromisoformat(state.get("step_started_at", ""))
        return int((datetime.now() - started).total_seconds())
    except (ValueError, TypeError):
        return 999  # 計算不可時は制限を無視 (safety で next を許可)


def _build_stage1_prompt(
    state: GuideGraphState,
    pipeline_type: str,
    user_message: str | None,
    guide_service: GuideService,
) -> str:
    """pipeline_type とステップ有無で 3 種類のプロンプトを出し分ける。

    periodic        : build_judgment_prompt       (定期判定)
    user_action+plan: build_user_action_prompt    (プランあり + 発話)
    user_action+none: build_explore_prompt        (探索モード)
    """
    current, nxt = _current_and_next(state)
    idx = state.get("current_step_index", 0)

    if pipeline_type == "periodic":
        return guide_service.build_judgment_prompt(
            current_step=current,
            next_step=nxt,
            recent_observations=state.get("recent_observations", []),
            current_step_index=idx,
            total_steps=state.get("total_steps", 0),
        )

    if current is not None:
        return guide_service.build_user_action_prompt(
            user_message=user_message or "",
            current_step=current,
            next_step=nxt,
            recent_observations=state.get("recent_observations", []),
            current_step_index=idx,
            total_steps=state.get("total_steps", 0),
            chat_history=state.get("chat_history", []),
        )

    return guide_service.build_explore_prompt(
        user_message=user_message or "",
        chat_history=state.get("chat_history", []),
    )


def _build_stage2_prompt(
    state: GuideGraphState,
    escalation_reason: str,
    user_message: str | None,
    guide_service: GuideService,
) -> str:
    """Stage 2 エスカレーションプロンプト。"""
    current, nxt = _current_and_next(state)
    return guide_service.build_stage2_prompt(
        escalation_reason=escalation_reason,
        current_step=current,
        next_step=nxt,
        user_message=user_message,
        recent_observations=state.get("recent_observations", []),
        current_step_index=state.get("current_step_index", 0),
        total_steps=state.get("total_steps", 0),
        chat_history=state.get("chat_history", []),
    )


def _should_escalate(stage1: Stage1Output, pipeline_type: str) -> bool:
    """エスカレーション条件。

    periodic    : anomaly + can_handle=False のみ (速度優先)
    user_action : can_handle=False なら常に (正確性優先)
    """
    if stage1.can_handle:
        return False
    if pipeline_type == "periodic":
        return stage1.judgment == "anomaly"
    return True


# ============================================================================
# config ヘルパ
# ============================================================================


def _cfg(config: RunnableConfig) -> dict:
    """config.configurable を取り出す。ネスト漏れ対策。"""
    return (config or {}).get("configurable", {}) or {}


# ============================================================================
# グラフ構築 — ノード群はクロージャで client を捕捉
# ============================================================================


def build_guide_graph(
    guide_service: GuideService,
    llm_client: LLMClient,
    hq_client: LLMClient | None = None,
    rag_client: MilvusRAGClient | None = None,
    embedding_client: EmbeddingClient | None = None,
    checkpointer: BaseCheckpointSaver | None = None,
) -> CompiledStateGraph:
    """Guide Agent の StateGraph を構築して compile 済みグラフを返す。

    checkpointer=AsyncRedisSaver を渡すと state が自動永続化される。
    None のときはメモリ内のみ (テスト用)。
    """
    _hq = hq_client or llm_client

    # ------------------------------------------------------------------
    # Stage 1: 高速判定 (Structured Output)
    # ------------------------------------------------------------------
    async def stage1_node(state: GuideGraphState, config: RunnableConfig) -> dict:
        """Gemma (or Claude) で Stage1Output を得る。

        - 非エスカレーション: state だけ更新、safety ノードで最終 emit
        - エスカレーション  : 中間イベントを即 emit (「少し調べますね」で UX 改善)
        """
        cfg = _cfg(config)
        image_bytes = cfg.get("image_bytes")
        user_message = cfg.get("user_message")
        pipeline_type = cfg.get("pipeline_type", "periodic")

        prompt = _build_stage1_prompt(state, pipeline_type, user_message, guide_service)

        logger.info(
            "[stage1] call pipeline=%s image=%s prompt_len=%d",
            pipeline_type,
            "yes" if image_bytes else "no",
            len(prompt),
        )
        t0 = time.monotonic()

        # Structured Output なので JSON パース不要、型安全
        stage1: Stage1Output = await llm_client.call_structured(
            system_prompt=prompt,
            schema=Stage1Output,
            image_bytes=image_bytes,
        )
        dt_ms = (time.monotonic() - t0) * 1000
        escalated = _should_escalate(stage1, pipeline_type)

        logger.info(
            "[stage1] j=%s conf=%.2f can_handle=%s esc=%s dt=%.0fms msg='%s'",
            stage1.judgment,
            stage1.confidence,
            stage1.can_handle,
            escalated,
            dt_ms,
            stage1.message[:50],
        )

        # エスカレーション時のみ中間イベントを emit (stage2 の待ち時間を埋める)
        if escalated:
            writer = get_stream_writer()
            writer(
                {
                    "stage": 1,
                    "escalated": True,
                    "judgment": stage1.judgment,
                    "confidence": stage1.confidence,
                    "message": stage1.message or "少し調べますね。",
                    "blocks": [],
                    "current_step_index": state.get("current_step_index", 0),
                }
            )

        # state に結果を書き込み (safety / stage2 で使う)
        return {
            "stage1": stage1.model_dump(),
            "escalated": escalated,
            "judgment": stage1.judgment,
            "confidence": stage1.confidence,
            "message": stage1.message,
            "blocks": [],
            "stage2": None,  # 前ターンの残滓を消す
        }

    # ------------------------------------------------------------------
    # Seed Stage 1 (エッジ推論からの持ち込み): stage1_node と同じ出力構造を作る
    # ------------------------------------------------------------------
    async def seed_stage1_node(state: GuideGraphState, config: RunnableConfig) -> dict:
        """クライアントが事前計算した Stage1Output を state に hydrate する。

        LLM 呼び出しなし。中間イベント emit まで stage1_node と揃える。
        将来 "エッジ stage1" が使われるときのためのパス。
        """
        cfg = _cfg(config)
        raw = cfg.get("precomputed_stage1")
        if not raw:
            # このノードは route_entry で precomputed_stage1 有り判定済み。
            # 念のため fallback: continue 扱い。
            return {
                "stage1": None,
                "escalated": False,
                "judgment": "continue",
                "confidence": 0.0,
                "message": "",
                "blocks": [],
                "stage2": None,
            }
        stage1 = Stage1Output.model_validate(raw)
        pipeline_type = cfg.get("pipeline_type", "periodic")
        escalated = _should_escalate(stage1, pipeline_type)

        logger.info(
            "[stage1/edge] j=%s conf=%.2f esc=%s msg='%s'",
            stage1.judgment,
            stage1.confidence,
            escalated,
            stage1.message[:50],
        )

        if escalated:
            writer = get_stream_writer()
            writer(
                {
                    "stage": 1,
                    "escalated": True,
                    "judgment": stage1.judgment,
                    "confidence": stage1.confidence,
                    "message": stage1.message or "少し調べますね。",
                    "blocks": [],
                    "current_step_index": state.get("current_step_index", 0),
                }
            )

        return {
            "stage1": stage1.model_dump(),
            "escalated": escalated,
            "judgment": stage1.judgment,
            "confidence": stage1.confidence,
            "message": stage1.message,
            "blocks": [],
            "stage2": None,
        }

    # ------------------------------------------------------------------
    # Stage 2: ツール付き深い推論 (create_react_agent)
    # ------------------------------------------------------------------
    async def stage2_node(state: GuideGraphState, config: RunnableConfig) -> dict:
        """HQ モデルで ReAct ループ + Stage2Output 取得 + tool artifact 回収。"""
        cfg = _cfg(config)
        image_bytes = cfg.get("image_bytes")
        user_message = cfg.get("user_message")

        stage1_raw = state.get("stage1") or {}
        reason = stage1_raw.get("escalation_reason", "")
        prompt = _build_stage2_prompt(state, reason, user_message, guide_service)

        tools = build_hq_tools(
            rag_client=rag_client,
            embedding_client=embedding_client,
            plan_steps_ref=_plan_step_objs(state),
            plan_source_id=state.get("plan_source_id", ""),
        )

        try:
            stage2, artifacts = await _hq.call_react_agent(
                system_prompt=prompt,
                tools=tools,
                response_schema=Stage2Output,
                image_bytes=image_bytes,
            )
            logger.info(
                "[stage2] j=%s conf=%.2f artifacts=%d msg='%s'",
                stage2.judgment,
                stage2.confidence,
                len(artifacts),
                stage2.message[:50],
            )
            return {
                "stage2": stage2.model_dump(),
                "judgment": stage2.judgment,
                "confidence": stage2.confidence,
                "message": stage2.message,
                "blocks": artifacts,
            }
        except Exception as e:
            logger.warning("[stage2] FAIL %s", e)
            # ハーネス: Stage2 失敗時はユーザーに通知だけして graph を続行
            return {
                "judgment": "continue",
                "confidence": 0.0,
                "message": "すみません、詳しく調べられませんでした。",
                "blocks": [AlertBlock(message="処理に失敗しました", severity="warning").model_dump()],
            }

    # ------------------------------------------------------------------
    # Safety: 最終ガード + 短期メモリ更新 + 最終 SSE emit
    # ------------------------------------------------------------------
    def safety_node(state: GuideGraphState, config: RunnableConfig) -> dict:
        """安全ガードを適用、session メモリ/コスト/進捗を更新、最終イベントを emit。

        - judgment=next なら current_step_index++ と step_started_at 更新
        - message があれば recent_observations に追記
        - pipeline_type=user_action なら chat_history に user/assistant を追記
        - total_calls / stage2_calls をインクリメント
        """
        cfg = _cfg(config)
        user_message = cfg.get("user_message")

        safe = apply_safety(
            judgment=state.get("judgment", "continue"),
            confidence=state.get("confidence", 0.5),
            message=state.get("message", ""),
            blocks=list(state.get("blocks", [])),
            plan_steps=_plan_step_objs(state),
            current_step_index=state.get("current_step_index", 0),
            current_step_duration_sec=_step_duration_sec(state),
        )

        # --- state 更新をまとめる ---
        updates: dict = {
            "judgment": safe["judgment"],
            "confidence": safe["confidence"],
            "message": safe["message"],
            "blocks": safe["blocks"],
        }

        # ステップ進行: safety 後の最終判定で next なら 1 つ進めて滞在時刻更新
        if safe["judgment"] == "next":
            updates["current_step_index"] = state.get("current_step_index", 0) + 1
            updates["step_started_at"] = datetime.now().isoformat()

        # 観察ログ (Stage1 のプロンプトが参照する)
        if safe["message"]:
            obs = list(state.get("recent_observations", []))
            obs.append(safe["message"])
            if len(obs) > MAX_OBSERVATIONS:
                obs = obs[-MAX_OBSERVATIONS:]
            updates["recent_observations"] = obs

        # 会話履歴: user_action 系のみ。Stage1/2 が参照する。
        pipeline_type = cfg.get("pipeline_type", "periodic")
        if user_message is not None and pipeline_type == "user_action":
            history = list(state.get("chat_history", []))
            history.append({"role": "user", "content": user_message})
            history.append({"role": "assistant", "content": safe["message"]})
            if len(history) > MAX_CHAT_HISTORY:
                history = history[-MAX_CHAT_HISTORY:]
            updates["chat_history"] = history

        # コスト管理 (ハーネス layer 1 の根拠)
        updates["total_calls"] = state.get("total_calls", 0) + 1
        if state.get("escalated"):
            updates["stage2_calls"] = state.get("stage2_calls", 0) + 1

        # --- 最終 SSE イベント ---
        final_stage = 2 if state.get("escalated") else 1
        writer = get_stream_writer()
        writer(
            {
                "stage": final_stage,
                "escalated": bool(state.get("escalated")),
                "judgment": safe["judgment"],
                "confidence": safe["confidence"],
                "message": safe["message"],
                "blocks": safe["blocks"],
                "current_step_index": updates.get("current_step_index", state.get("current_step_index", 0)),
            }
        )
        return updates

    # ------------------------------------------------------------------
    # Calibrate: 初期位置推定 (1-shot)
    # ------------------------------------------------------------------
    async def calibrate_node(state: GuideGraphState, config: RunnableConfig) -> dict:
        """プラン開始時のキャリブレーション。Structured Output で step_number を取得。"""
        cfg = _cfg(config)
        image_bytes = cfg.get("image_bytes")
        steps = _plan_step_objs(state)
        writer = get_stream_writer()

        if not image_bytes or not steps:
            writer(
                {
                    "stage": 1,
                    "escalated": False,
                    "judgment": "calibrated",
                    "confidence": 0.0,
                    "message": "画像または計画が不足しています",
                    "blocks": [],
                    "current_step_index": 0,
                }
            )
            return {
                "judgment": "calibrated",
                "current_step_index": 0,
                "step_started_at": datetime.now().isoformat(),
            }

        prompt = guide_service.build_calibration_prompt(steps)
        result: CalibrationOutput = await llm_client.call_structured(
            system_prompt=prompt,
            schema=CalibrationOutput,
            image_bytes=image_bytes,
        )
        idx = max(0, min(result.step_number - 1, len(steps) - 1))
        logger.info(
            "[calibrate] step=%d conf=%.2f msg='%s'",
            idx + 1,
            result.confidence,
            result.message[:50],
        )

        writer(
            {
                "stage": 1,
                "escalated": False,
                "judgment": "calibrated",
                "confidence": result.confidence,
                "message": f"Step {idx + 1} から開始: {result.message}",
                "blocks": [],
                "current_step_index": idx,
            }
        )
        return {
            "judgment": "calibrated",
            "confidence": result.confidence,
            "message": f"Step {idx + 1} から開始: {result.message}",
            "current_step_index": idx,
            "step_started_at": datetime.now().isoformat(),
        }

    # ------------------------------------------------------------------
    # 条件分岐 (ルータ)
    # ------------------------------------------------------------------
    def route_entry(state: GuideGraphState, config: RunnableConfig) -> str:
        """START → calibrate | seed_stage1 | stage1 の振り分け。

        is_calibration=True         → calibrate
        precomputed_stage1 あり     → seed_stage1  (エッジ推論経路)
        それ以外                    → stage1        (cloud 推論経路)
        """
        cfg = _cfg(config)
        if cfg.get("is_calibration"):
            return "calibrate"
        if cfg.get("precomputed_stage1"):
            return "seed_stage1"
        return "stage1"

    def route_after_stage1(state: GuideGraphState) -> str:
        """Stage1 / Seed Stage1 → stage2 (エスカレーション) | safety (直通)。"""
        return "stage2" if state.get("escalated") else "safety"

    # ------------------------------------------------------------------
    # グラフ組み立て
    # ------------------------------------------------------------------
    sg = StateGraph(GuideGraphState)
    sg.add_node("stage1", stage1_node)
    sg.add_node("seed_stage1", seed_stage1_node)
    sg.add_node("stage2", stage2_node)
    sg.add_node("safety", safety_node)
    sg.add_node("calibrate", calibrate_node)

    sg.add_conditional_edges(
        START,
        route_entry,
        {"calibrate": "calibrate", "stage1": "stage1", "seed_stage1": "seed_stage1"},
    )
    # stage1 と seed_stage1 は同じ判定で次に進む
    sg.add_conditional_edges(
        "stage1",
        route_after_stage1,
        {"stage2": "stage2", "safety": "safety"},
    )
    sg.add_conditional_edges(
        "seed_stage1",
        route_after_stage1,
        {"stage2": "stage2", "safety": "safety"},
    )
    sg.add_edge("stage2", "safety")
    sg.add_edge("safety", END)
    sg.add_edge("calibrate", END)

    return sg.compile(checkpointer=checkpointer)
