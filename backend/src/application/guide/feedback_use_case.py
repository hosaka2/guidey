"""フィードバックユースケース (/guide/feedback).

SQLite に永続化するだけの薄いサービス。
plan_retry sentiment のときは FailedPlan も別テーブルに記録する。
"""

import logging

from src.application.guide.schemas import FeedbackRequest, FeedbackResponse
from src.domain.guide.model import FailedPlan, Feedback
from src.infrastructure.repositories.feedback_repository import SqliteFeedbackRepository

logger = logging.getLogger(__name__)


class FeedbackUseCase:
    def __init__(self, repo: SqliteFeedbackRepository | None = None):
        self._repo = repo or SqliteFeedbackRepository()

    def submit(self, request: FeedbackRequest) -> FeedbackResponse:
        fb = Feedback(**request.model_dump())
        fid = self._repo.save(fb)
        if request.sentiment == "plan_retry":
            fp = FailedPlan(
                plan_source_id=request.target_id,
                task_description=request.target_content,
                abandoned_at_step=request.step_index or 0,
                reason=request.raw_content,
            )
            self._repo.save_failed_plan(fp)
        return FeedbackResponse(feedback_id=fid)
