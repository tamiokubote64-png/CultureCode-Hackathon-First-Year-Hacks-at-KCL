"""Fixed response contract shared with the frontend and music engine."""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

Score = Annotated[float, Field(ge=0.0, le=1.0, allow_inf_nan=False)]


class VisualScores(BaseModel):
    model_config = ConfigDict(extra="forbid")

    grandeur: Score
    energy: Score
    brightness: Score
    density: Score
    warmth: Score


class VisualExplanations(BaseModel):
    model_config = ConfigDict(extra="forbid")

    grandeur: str
    energy: str
    brightness: str
    density: str
    warmth: str


class VisualAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scene: str
    description: str
    scores: VisualScores
    explanations: VisualExplanations
