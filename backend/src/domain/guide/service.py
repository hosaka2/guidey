from src.domain.guide.model import (
    PlanStep,
    RagResult,
)
from src.domain.guide.prompt_loader import (
    Prompt,
    build_chat_history_section,
    build_multi_source_section,
    build_next_step_line,
    build_observations_section,
    build_progress_section,
    build_rag_section,
    build_step_section,
    render,
)

__all__ = ["GuideService"]


class GuideService:

    def build_system_prompt(
        self,
        trigger_word: str,
        goal: str = "",
        rag_results: list[RagResult] | None = None,
    ) -> str:
        rag_section = ""
        if rag_results:
            steps_text = "\n".join(
                f"  ステップ {r.step_number}/{r.total_steps}: {r.text}"
                for r in rag_results
            )
            rag_section = f"参考手順:\n{steps_text}"

        return render(
            Prompt.ANALYZE_ONESHOT,
            goal_line=f"ユーザーの目的: 「{goal}」" if goal else "",
            rag_section=rag_section,
            trigger_word=trigger_word,
        )

    def build_judgment_prompt(
        self,
        current_step: PlanStep | None,
        next_step: PlanStep | None = None,
        recent_observations: list[str] | None = None,
        current_step_index: int = 0,
        total_steps: int = 0,
    ) -> str:
        """自律モード: Proactive判定プロンプト."""
        if not current_step:
            return "ステップ情報がありません。"

        next_section = ""
        if next_step:
            next_section = (
                f"\n## 次のステップ (Step {next_step.step_number})\n"
                f"内容: {next_step.text}"
            )

        return render(
            Prompt.PERIODIC_STAGE1,
            step_number=str(current_step.step_number),
            step_text=current_step.text,
            visual_marker_line=(
                f"完了の目印: {current_step.visual_marker}"
                if current_step.visual_marker else ""
            ),
            progress_section=build_progress_section(current_step_index, total_steps),
            next_step_section=next_section,
            observations_section=build_observations_section(recent_observations),
        )

    def build_user_action_prompt(
        self,
        user_message: str,
        current_step: PlanStep | None = None,
        next_step: PlanStep | None = None,
        recent_observations: list[str] | None = None,
        current_step_index: int = 0,
        total_steps: int = 0,
        chat_history: list[dict] | None = None,
    ) -> str:
        """ユーザーアクション用 Stage 1 プロンプト."""
        step_section = ""
        if current_step:
            step_section = build_step_section(
                current_step.step_number,
                current_step.text,
                current_step.visual_marker,
            )
            if next_step:
                step_section += f"\n{build_next_step_line(next_step.step_number, next_step.text)}"

        return render(
            Prompt.USER_ACTION_STAGE1,
            current_step_section=step_section,
            progress_section=build_progress_section(current_step_index, total_steps),
            observations_section=build_observations_section(recent_observations),
            chat_history_section=build_chat_history_section(chat_history or []),
            user_message=user_message,
        )

    def build_stage2_prompt(
        self,
        escalation_reason: str = "",
        current_step: PlanStep | None = None,
        next_step: PlanStep | None = None,
        user_message: str | None = None,
        recent_observations: list[str] | None = None,
        current_step_index: int = 0,
        total_steps: int = 0,
        chat_history: list[dict] | None = None,
    ) -> str:
        """Stage 2 エスカレーションプロンプト."""
        step_section = ""
        if current_step:
            step_section = build_step_section(
                current_step.step_number,
                current_step.text,
                current_step.visual_marker,
            )

        return render(
            Prompt.STAGE2_ESCALATION,
            escalation_reason_line=(
                f"エスカレーション理由: {escalation_reason}"
                if escalation_reason else ""
            ),
            current_step_section=step_section,
            next_step_line=(
                build_next_step_line(next_step.step_number, next_step.text)
                if next_step else ""
            ),
            progress_section=build_progress_section(current_step_index, total_steps),
            user_message_line=(
                f"\nユーザーの発話: 「{user_message}」"
                if user_message else ""
            ),
            observations_section=build_observations_section(recent_observations),
            chat_history_section=build_chat_history_section(chat_history or []),
        )

    def build_plan_generation_prompt(
        self,
        goal: str,
        rag_results: list[RagResult] | None = None,
        multi_source_context: str = "",
    ) -> str:
        """プラン自動生成プロンプト."""
        if multi_source_context:
            source_section = build_multi_source_section(multi_source_context)
        elif rag_results:
            source_section = build_rag_section(rag_results)
        else:
            source_section = ""

        return render(
            Prompt.PLAN_GENERATION,
            goal=goal,
            source_section=source_section,
        )

    def build_calibration_prompt(self, steps: list[PlanStep]) -> str:
        steps_desc = "\n".join(f"Step {s.step_number}: {s.text}" for s in steps)
        return render(Prompt.CALIBRATION, steps_description=steps_desc)

    def build_appraise_caption_prompt(self) -> str:
        return render(Prompt.APPRAISE_CAPTION)

    def build_explore_prompt(
        self,
        user_message: str,
        chat_history: list[dict] | None = None,
    ) -> str:
        """探索モード用 Stage 1 プロンプト."""
        return render(
            Prompt.EXPLORE_STAGE1,
            chat_history_section=build_chat_history_section(chat_history or []),
            user_message=user_message,
        )
