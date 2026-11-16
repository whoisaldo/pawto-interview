from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.schemas.submissions import MAX_CODE_BYTES

AiPolicy = Literal["allowed", "disabled"]
Recommendation = Literal["undecided", "advance", "hold", "decline"]

MIN_DURATION_SECONDS = 60
MAX_DURATION_SECONDS = 4 * 3600
MAX_CRITERIA = 20
MAX_CRITERION_CHARS = 500


class BriefEdit(BaseModel):
    """Per-session wording. A field left out is unchanged; null restores the library's."""

    statement: str | None = Field(default=None, max_length=8000)
    acceptanceCriteria: list[str] | None = Field(default=None, max_length=MAX_CRITERIA)
    starterCode: str | None = Field(default=None, max_length=MAX_CODE_BYTES)

    @field_validator("acceptanceCriteria")
    @classmethod
    def _criteria_are_short_lines(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        cleaned = [line.strip() for line in value if line.strip()]
        if any(len(line) > MAX_CRITERION_CHARS for line in cleaned):
            raise ValueError(f"Each acceptance criterion is at most {MAX_CRITERION_CHARS} characters")
        return cleaned

    @field_validator("statement")
    @classmethod
    def _blank_statement_is_none(cls, value: str | None) -> str | None:
        return value if value and value.strip() else None


class CreateInterviewRequest(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    candidateName: str = Field(min_length=1, max_length=80)
    candidateEmail: str | None = Field(default=None, max_length=254)
    problemId: UUID
    durationSeconds: int = Field(ge=MIN_DURATION_SECONDS, le=MAX_DURATION_SECONDS)
    # No default: whether a candidate may use AI is always somebody's decision.
    aiPolicy: AiPolicy
    brief: BriefEdit | None = None

    @field_validator("title", "candidateName")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Must not be blank")
        return value


class UpdateInterviewRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    candidateName: str | None = Field(default=None, min_length=1, max_length=80)
    candidateEmail: str | None = Field(default=None, max_length=254)
    problemId: UUID | None = None
    durationSeconds: int | None = Field(default=None, ge=MIN_DURATION_SECONDS, le=MAX_DURATION_SECONDS)
    aiPolicy: AiPolicy | None = None
    brief: BriefEdit | None = None

    @field_validator("title", "candidateName")
    @classmethod
    def _not_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("Must not be blank")
        return value


class RevealRequest(BaseModel):
    revealed: bool


class JoinRequest(BaseModel):
    inviteCode: str = Field(min_length=8, max_length=64)


class EvidenceItem(BaseModel):
    # None is "unobserved", which is why this is not an int with a default.
    score: Literal[0, 1, 2] | None = None
    note: str = Field(default="", max_length=4000)


class EvidenceSet(BaseModel):
    clarification: EvidenceItem = EvidenceItem()
    verification: EvidenceItem = EvidenceItem()
    understanding: EvidenceItem = EvidenceItem()
    ownership: EvidenceItem = EvidenceItem()


class EvaluationRequest(BaseModel):
    evidence: EvidenceSet
    summary: str = Field(default="", max_length=8000)
    recommendation: Recommendation = "undecided"


class SettingsRequest(BaseModel):
    defaultDurationSeconds: int = Field(ge=MIN_DURATION_SECONDS, le=MAX_DURATION_SECONDS)
    defaultAiPolicy: AiPolicy


class ContextSelection(BaseModel):
    """What the asker ticked. Each one off means that part is not sent."""

    prompt: bool = False
    code: bool = False
    tests: bool = False


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    context: ContextSelection = ContextSelection()
    # The editor's text, sent only when `context.code` is on. The server keeps
    # no copy of the shared document, so this is the one part the client supplies.
    code: str | None = Field(default=None, max_length=MAX_CODE_BYTES)
    conversationId: UUID | None = None

    @field_validator("question")
    @classmethod
    def _question_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Ask a question")
        return value


class DemoOperatorRequest(BaseModel):
    accessCode: str = Field(min_length=1, max_length=200)


class DemoCandidateRequest(BaseModel):
    inviteCode: str = Field(min_length=8, max_length=64)
