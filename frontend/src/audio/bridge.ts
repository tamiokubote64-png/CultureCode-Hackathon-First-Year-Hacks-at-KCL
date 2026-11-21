/**
 * bridge.ts — adapts external data sources into VisualAnalysis and plays music.
 *
 * - adaptStreamlitResult: converts Streamlit (ui.py) output into VisualAnalysis.
 * - playImageOrFallback: calls the backend API or falls back to a mock preset.
 */
import type { VisualAnalysis } from "../types/analysis";
import { playFromAnalysis } from "./engine";
import { NYC_MOCK, SOHO_MOCK } from "./fixtures";

// ------------------------------------------------------------------ types

/** Shape of the result produced by ui.py (Streamlit) */
interface StreamlitResult {
  env: string;
  why: string;
  time: string;
  weather: string;
  feats: Array<{ label: string; x: number; y: number; pct: number }>;
}

/** Return type of playImageOrFallback */
interface PlayResult {
  source: "api" | "nyc" | "soho";
  analysis: VisualAnalysis;
}

// ------------------------------------------------------------------ helpers

/** Clamp a value to [0, 1] */
function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Derive a simple score from whether a keyword appears in any of the strings */
function keywordScore(strings: string[], keywords: string[]): number {
  const text = strings.join(" ").toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (text.includes(kw)) hits++;
  }
  return clamp(hits / Math.max(keywords.length, 1));
}

/**
 * Heuristic: derive five scores from the Streamlit result's metadata.
 *
 * Uses environment label, time of day, weather, and detected features
 * to approximate the five dimensions the audio engine expects.
 */
function deriveScores(result: StreamlitResult): VisualAnalysis["scores"] {
  const env = result.env.toLowerCase();
  const time = result.time.toLowerCase();
  const weather = result.weather.toLowerCase();
  const labels = result.feats.map((f) => f.label.toLowerCase());
  const allText = [env, result.why, time, weather, ...labels];

  // Grandeur: tall buildings, monuments, skyline
  const grandeur = clamp(
    (env.includes("city") ? 0.3 : 0) +
      (env.includes("town") ? 0.15 : 0) +
      keywordScore(allText, ["skyscraper", "tower", "monument", "skyline", "tall", "grand"]) * 0.7,
  );

  // Energy: traffic, people, activity
  const energy = clamp(
    (env.includes("city") ? 0.25 : 0) +
      keywordScore(allText, ["traffic", "busy", "crowd", "people", "activity", "rush", "movement"]) * 0.75,
  );

  // Brightness: time of day and weather
  const brightness = clamp(
    (time.includes("night") ? 0.1 : 0) +
      (time.includes("dawn") || time.includes("dusk") || time.includes("sunset") ? 0.4 : 0) +
      (time.includes("day") || time.includes("noon") || time.includes("morning") ? 0.7 : 0) +
      (weather.includes("cloud") || weather.includes("overcast") || weather.includes("fog") ? -0.15 : 0) +
      (weather.includes("clear") || weather.includes("sunny") ? 0.1 : 0) +
      (allText.length > 0 && !time ? 0.5 : 0), // default when time is unknown
  );

  // Density: packed buildings, vehicles, people
  const density = clamp(
    (env.includes("city") ? 0.3 : 0) +
      keywordScore(allText, ["dense", "packed", "crowded", "cluster", "row", "line", "street"]) * 0.7,
  );

  // Warmth: warm colors, sunset, brick, golden light
  const warmth = clamp(
    (time.includes("sunset") || time.includes("sunrise") || time.includes("golden") ? 0.3 : 0) +
      (time.includes("night") ? -0.1 : 0) +
      keywordScore(allText, ["warm", "golden", "brick", "orange", "red", "amber", "yellow"]) * 0.7 +
      (weather.includes("cold") || weather.includes("snow") ? -0.15 : 0),
  );

  return {
    grandeur: Math.round(grandeur * 100) / 100,
    energy: Math.round(energy * 100) / 100,
    brightness: Math.round(brightness * 100) / 100,
    density: Math.round(density * 100) / 100,
    warmth: Math.round(warmth * 100) / 100,
  };
}

/** Build explanation strings from the Streamlit result */
function deriveExplanations(
  result: StreamlitResult,
  scores: VisualAnalysis["scores"],
): VisualAnalysis["explanations"] {
  const context = `${result.env} — ${result.time}${result.weather ? ", " + result.weather : ""}`;
  const featureList = result.feats.length
    ? ` Detected features: ${result.feats.map((f) => f.label).join(", ")}.`
    : "";

  return {
    grandeur: `Grandeur ${scores.grandeur.toFixed(2)}: ${result.why}${featureList}`,
    energy: `Energy ${scores.energy.toFixed(2)}: ${context}.${featureList}`,
    brightness: `Brightness ${scores.brightness.toFixed(2)}: ${context}`,
    density: `Density ${scores.density.toFixed(2)}: ${context}.${featureList}`,
    warmth: `Warmth ${scores.warmth.toFixed(2)}: ${context}`,
  };
}

// ------------------------------------------------------------------ public API

/**
 * Map a Streamlit-style result ({ env, why, time, weather, feats })
 * into a VisualAnalysis object compatible with the Tone.js audio engine.
 */
export function adaptStreamlitResult(result: StreamlitResult): VisualAnalysis {
  const scores = deriveScores(result);
  return {
    scene: result.env,
    description: result.why,
    scores,
    explanations: deriveExplanations(result, scores),
  };
}

/**
 * Analyze an uploaded image via the backend API and play generated music.
 *
 * - If `file` is provided, sends it to `POST http://localhost:8000/api/analyze`.
 * - If the request fails or no file is provided, falls back to the mock preset.
 * - Returns the source ("api" | "nyc" | "soho") and the analysis used.
 */
export async function playImageOrFallback(
  file?: File,
  fallbackPreset: "nyc" | "soho" = "nyc",
): Promise<PlayResult> {
  // No file — use fallback immediately
  if (!file) {
    const analysis = fallbackPreset === "soho" ? SOHO_MOCK : NYC_MOCK;
    await playFromAnalysis(analysis);
    return { source: fallbackPreset, analysis };
  }

  // Try the backend API
  try {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch("http://localhost:8000/api/analyze", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const analysis: VisualAnalysis = await response.json();
    await playFromAnalysis(analysis);
    return { source: "api", analysis };
  } catch {
    // Backend unavailable — fall back to mock
    const analysis = fallbackPreset === "soho" ? SOHO_MOCK : NYC_MOCK;
    await playFromAnalysis(analysis);
    return { source: fallbackPreset, analysis };
  }
}
