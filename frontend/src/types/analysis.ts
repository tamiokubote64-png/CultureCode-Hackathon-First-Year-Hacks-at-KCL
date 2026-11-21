export interface VisualAnalysis {
  scene: string;
  description: string;
  scores: {
    grandeur: number;
    energy: number;
    brightness: number;
    density: number;
    warmth: number;
  };
  explanations: {
    grandeur: string;
    energy: string;
    brightness: string;
    density: string;
    warmth: string;
  };
}
