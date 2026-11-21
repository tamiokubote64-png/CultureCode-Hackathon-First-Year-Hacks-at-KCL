/** Lightweight, deterministic on-device image analysis.
 * No network request, API key, ML model, or backend is required.
 * Scores are visual proxies, not identification of people or landmarks.
 */
import type { VisualAnalysis } from '../types/analysis';

const EDGE = 96;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const round = (x: number) => Math.round(clamp(x) * 100) / 100;

export async function analyzeImageLocally(file: File): Promise<VisualAnalysis> {
  const url = URL.createObjectURL(file);
  let bitmap: ImageBitmap | null = null;
  try {
    const blob = await fetch(url).then(r => r.blob());
    bitmap = await createImageBitmap(blob);
    if (bitmap.width * bitmap.height > 20_000_000) throw new Error('Image exceeds the 20 megapixel limit.');
    const canvas = document.createElement('canvas');
    canvas.width = EDGE;
    canvas.height = EDGE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Image analysis is not supported in this browser.');
    context.drawImage(bitmap, 0, 0, EDGE, EDGE);
    const rgba = context.getImageData(0, 0, EDGE, EDGE).data;
    const n = EDGE * EDGE;
    const luminance = new Float32Array(n);
    let lightSum = 0, warmthSum = 0, saturationSum = 0, greenPixels = 0, bluePixels = 0;
    for (let i = 0; i < n; i++) {
      const offset = i * 4;
      const r = rgba[offset] / 255, g = rgba[offset + 1] / 255, b = rgba[offset + 2] / 255;
      // Perceived luminance and simple RGB colour proxies.
      const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luminance[i] = light;
      lightSum += light;
      warmthSum += (r - b + 1) / 2;
      saturationSum += Math.max(r, g, b) - Math.min(r, g, b);
      if (g > r * 1.12 && g > b * 1.08) greenPixels++;
      if (b > r * 1.13 && b > g * 1.06) bluePixels++;
    }
    let edgeSum = 0, strongEdges = 0, upperEdges = 0, lowerEdges = 0;
    let verticalEdges = 0;
    for (let y = 1; y < EDGE - 1; y++) {
      for (let x = 1; x < EDGE - 1; x++) {
        const i = y * EDGE + x;
        const dx = Math.abs(luminance[i + 1] - luminance[i - 1]) / 2;
        const dy = Math.abs(luminance[i + EDGE] - luminance[i - EDGE]) / 2;
        const edge = Math.min(1, (dx + dy) * 1.6);
        edgeSum += edge;
        if (edge > 0.16) {
          strongEdges++;
          if (y < EDGE / 2) upperEdges++; else lowerEdges++;
        }
        if (dx > 0.14 && dx > dy * 1.4) verticalEdges++;
      }
    }
    const interior = (EDGE - 2) ** 2;
    const edgeDensity = strongEdges / interior;
    const texture = edgeSum / interior;
    const green = greenPixels / n;
    const blue = bluePixels / n;
    const brightness = round(lightSum / n);
    const warmth = round(warmthSum / n);
    const density = round(edgeDensity * 2.8 + texture * 1.5);
    // Energy describes visual busyness/contrast, not actual detected movement.
    const energy = round(0.10 + 0.62 * density + 0.28 * (saturationSum / n));
    // Grandeur is a weak architectural/scale proxy. No building recognition.
    const grandeur = round(0.2 + 1.8 * (verticalEdges / interior) + 0.55 * (upperEdges / interior) + 0.18 * density);
    const colourful = saturationSum / n;
    const scene =
      green > 0.22 ? 'Green-toned landscape' :
      blue > 0.23 && density < 0.48 ? 'Open blue-toned scene' :
      density > 0.55 && lowerEdges > upperEdges * 0.65 ? 'Visually busy scene' :
      density < 0.25 ? 'Open, minimal scene' : 'Layered photographic scene';
    const description = `Local pixel analysis found a ${brightness >= 0.65 ? 'bright' : brightness <= 0.35 ? 'dim' : 'moderately lit'} image with ${density >= 0.6 ? 'dense detail' : density <= 0.3 ? 'little visual clutter' : 'moderate visual detail'} and a ${warmth >= 0.58 ? 'warmer' : warmth <= 0.42 ? 'cooler' : 'balanced'} colour balance. These are image-derived estimates, not AI object recognition.`;
    const scores = { grandeur, energy, brightness, density, warmth };
    return {
      scene,
      description,
      scores,
      explanations: {
        grandeur: 'Estimated from vertical edges and upper-image detail; this does not reliably measure building height or physical scale.',
        energy: `Estimated from visual busyness and colour variation (${Math.round(colourful * 100)}% mean channel spread); movement and crowds are not detected.`,
        brightness: 'Calculated from average perceived pixel luminance.',
        density: 'Calculated from local edges and texture; strong edges indicate more visual detail.',
        warmth: 'Calculated from the balance of red and blue pixel channels.',
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('Image')) throw error;
    throw new Error('Could not decode the photograph. Choose a valid JPG, PNG or WebP file.');
  } finally {
    bitmap?.close();
    URL.revokeObjectURL(url);
  }
}
