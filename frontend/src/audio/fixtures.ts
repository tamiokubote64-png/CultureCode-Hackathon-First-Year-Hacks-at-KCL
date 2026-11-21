// Illustrative scores for listening tests. NOT measurements of any photograph.
import type { VisualAnalysis } from "../types/analysis";

export const NYC_MOCK: VisualAnalysis = {
  scene: "Midtown Manhattan avenue (illustrative)",
  description: "A monumental, energetic urban street scene",
  scores: { grandeur: 0.95, energy: 0.85, brightness: 0.7, density: 0.9, warmth: 0.45 },
  explanations: {
    grandeur: "Towering skyscrapers and deep perspective",
    energy: "Dense traffic and pedestrian activity",
    brightness: "Bright daylight reflecting off buildings",
    density: "Closely packed buildings, vehicles and people",
    warmth: "Mostly cool architectural tones",
  },
};

export const SOHO_MOCK: VisualAnalysis = {
  scene: "Quiet SoHo street at dawn (illustrative)",
  description: "A calm, warm street before the city wakes",
  scores: { grandeur: 0.5, energy: 0.15, brightness: 0.4, density: 0.25, warmth: 0.75 },
  explanations: {
    grandeur: "Mid-rise cast-iron buildings frame the street",
    energy: "Almost no traffic or people",
    brightness: "Soft early light",
    density: "Sparse, open street",
    warmth: "Warm brick and low sun",
  },
};
