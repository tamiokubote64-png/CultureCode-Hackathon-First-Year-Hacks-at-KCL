import './style.css';
import { analyzeImageLocally } from './analysis/local';
import type { VisualAnalysis } from './types/analysis';
import { getMusicDescription, isPlaying, onPlaybackEnded, playFromAnalysis, stopPlayback } from './audio/engine';

const MAX_BYTES = 5 * 1024 * 1024;
const accepted = new Set(['image/jpeg', 'image/png', 'image/webp']);
const metrics = ['grandeur', 'energy', 'brightness', 'density', 'warmth'] as const;
type Metric = typeof metrics[number];

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Missing app element');

root.innerHTML = `
  <header class="site-header"><a class="brand" href="/" aria-label="Sonic Postcodes home"><span class="brand-icon">♫</span> SONIC <span>POSTCODES</span></a><span class="header-note">Your city, composed.</span></header>
  <main class="shell">
    <section class="intro">
      <div class="eyebrow"><span class="dot"></span> PHOTO → SOUND</div>
      <h1>Hear the world<br/><em>around you.</em></h1>
      <p>Upload a city or street photograph. Our visual intelligence reads its atmosphere, then transforms five visual qualities into a one-of-a-kind musical composition.</p>
    </section>
    <div class="analysis-mode"><label for="mode">Analysis method</label><select id="mode"><option value="local" selected>Offline · on-device (no API key)</option><option value="api">OpenAI vision API (optional, requires FastAPI)</option></select><small id="mode-help">Local image analysis estimates visual characteristics from pixels. No photo is uploaded.</small></div>
    <section class="workspace">
      <div class="card upload-card">
        <div class="section-heading"><span class="step">01</span><h2>Your photograph</h2></div>
        <label class="dropzone" id="dropzone" for="photo">
          <input id="photo" type="file" accept="image/jpeg,image/png,image/webp" />
          <span id="placeholder"><span class="upload-icon">↑</span><strong>Choose a photograph</strong><small>or drag and drop it here</small><small>JPG, PNG or WebP · up to 5 MiB</small></span>
          <img id="preview" alt="Selected city photograph" hidden />
        </label>
        <div class="file-line"><span id="file-name">No image selected</span><button type="button" id="clear" class="text-button" disabled>Remove</button></div>
        <button type="button" id="analyze" class="primary" disabled>Analyze photograph <span aria-hidden="true">→</span></button>
      </div>
      <div class="card results-card">
        <div class="section-heading"><span class="step">02</span><h2>Visual intelligence</h2></div>
        <div id="empty" class="empty-state"><span class="equalizer">▂ ▅ ▃ ▇ ▄</span><strong>Your scene awaits</strong><p>Upload an image to discover its visual characteristics.</p></div>
        <div id="results" hidden>
          <h3 id="scene"></h3><p id="description" class="scene-description"></p>
          <div id="scores" class="scores"></div>
        </div>
      </div>
    </section>
    <section id="music-panel" class="card music-card" hidden>
      <div class="section-heading"><span class="step">03</span><h2>Your city soundtrack</h2></div>
      <div class="music-layout"><div><p class="eyebrow">GENERATED FROM YOUR PHOTOGRAPH</p><h3 id="mood"></h3><p id="music-description"></p><p id="tempo" class="tempo"></p></div>
      <div class="play-controls"><button type="button" class="primary" id="play">▶ Play composition</button><button type="button" id="stop" class="secondary" disabled>■ Stop</button></div></div>
    </section>
    <p id="status" class="status" role="status" aria-live="polite"></p>
  </main>
  <footer>SONIC POSTCODES · KCL FIRST YEAR HACKS · MADE FROM IMAGES, PLAYED AS MUSIC</footer>
`;

const photo = document.querySelector<HTMLInputElement>('#photo')!;
const mode = document.querySelector<HTMLSelectElement>('#mode')!;
const modeHelp = document.querySelector<HTMLElement>('#mode-help')!;
const dropzone = document.querySelector<HTMLLabelElement>('#dropzone')!;
const preview = document.querySelector<HTMLImageElement>('#preview')!;
const placeholder = document.querySelector<HTMLElement>('#placeholder')!;
const filename = document.querySelector<HTMLElement>('#file-name')!;
const clear = document.querySelector<HTMLButtonElement>('#clear')!;
const analyze = document.querySelector<HTMLButtonElement>('#analyze')!;
const results = document.querySelector<HTMLElement>('#results')!;
const empty = document.querySelector<HTMLElement>('#empty')!;
const musicPanel = document.querySelector<HTMLElement>('#music-panel')!;
const play = document.querySelector<HTMLButtonElement>('#play')!;
const stop = document.querySelector<HTMLButtonElement>('#stop')!;
const status = document.querySelector<HTMLElement>('#status')!;

let selected: File | null = null;
let analyzing = false;
let objectUrl: string | null = null;
let currentAnalysis: VisualAnalysis | null = null;
let controller: AbortController | null = null;
let requestId = 0;

function message(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function resetAnalysis(): void {
  stopPlayback();
  currentAnalysis = null;
  results.hidden = true;
  musicPanel.hidden = true;
  empty.hidden = false;
  play.disabled = true;
  stop.disabled = true;
  play.textContent = '▶ Play composition';
}

function selectFile(file: File | null): void {
  requestId++;
  controller?.abort();
  controller = null;
  analyzing = false;
  analyze.disabled = false;
  analyze.textContent = 'Analyze photograph →';
  resetAnalysis();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  selected = null;
  preview.hidden = true;
  preview.removeAttribute('src');
  placeholder.hidden = false;
  filename.textContent = 'No image selected';
  clear.disabled = true;
  message('');
  if (!file) { photo.value = ''; analyze.disabled = true; return; }
  if (!accepted.has(file.type)) { message('Choose a JPG, PNG or WebP image.', true); analyze.disabled = true; return; }
  if (file.size === 0 || file.size > MAX_BYTES) { message('Image must be nonempty and no larger than 5 MiB.', true); analyze.disabled = true; return; }
  selected = file;
  objectUrl = URL.createObjectURL(file);
  preview.src = objectUrl;
  preview.hidden = false;
  placeholder.hidden = true;
  filename.textContent = file.name;
  clear.disabled = false;
}

function isAnalysis(data: unknown): data is VisualAnalysis {
  if (typeof data !== 'object' || data === null) return false;
  const a = data as Record<string, unknown>;
  if (typeof a.scene !== 'string' || typeof a.description !== 'string') return false;
  if (typeof a.scores !== 'object' || a.scores === null || typeof a.explanations !== 'object' || a.explanations === null) return false;
  const scores = a.scores as Record<string, unknown>, explanations = a.explanations as Record<string, unknown>;
  return metrics.every(k => typeof scores[k] === 'number' && Number.isFinite(scores[k]) && (scores[k] as number) >= 0 && (scores[k] as number) <= 1 && typeof explanations[k] === 'string');
}

function renderAnalysis(data: VisualAnalysis): void {
  currentAnalysis = data;
  document.querySelector<HTMLElement>('#scene')!.textContent = data.scene;
  document.querySelector<HTMLElement>('#description')!.textContent = data.description;
  const scoreContainer = document.querySelector<HTMLElement>('#scores')!;
  scoreContainer.replaceChildren();
  for (const metric of metrics) {
    const value = data.scores[metric];
    const row = document.createElement('div');
    row.className = 'score-item';
    const heading = document.createElement('div');
    heading.className = 'score-heading';
    const label = document.createElement('strong');
    label.textContent = metric[0].toUpperCase() + metric.slice(1);
    const percentage = document.createElement('span');
    percentage.textContent = Math.round(value * 100) + '%';
    heading.append(label, percentage);
    const track = document.createElement('div');
    track.className = 'score-track';
    const bar = document.createElement('div');
    bar.className = 'score-bar';
    bar.style.width = Math.round(value * 100) + '%';
    track.append(bar);
    const explanation = document.createElement('p');
    explanation.textContent = data.explanations[metric as Metric];
    row.append(heading, track, explanation);
    scoreContainer.append(row);
  }
  const music = getMusicDescription(data);
  document.querySelector<HTMLElement>('#mood')!.textContent = music.mood;
  document.querySelector<HTMLElement>('#music-description')!.textContent = music.explanation;
  document.querySelector<HTMLElement>('#tempo')!.textContent = music.bpm + ' BPM · approximately 20–30 seconds';
  empty.hidden = true;
  results.hidden = false;
  musicPanel.hidden = false;
  play.disabled = false;
  stop.disabled = true;
  message('Analysis complete. Press Play to hear your soundtrack.');
}

mode.addEventListener('change', () => {
  requestId++;
  controller?.abort();
  controller = null;
  resetAnalysis();
  analyze.disabled = !selected;
  analyze.textContent = 'Analyze photograph →';
  message('');
  modeHelp.textContent = mode.value === 'local'
    ? 'Local image analysis estimates visual characteristics from pixels. No photo is uploaded.'
    : 'OpenAI vision needs the FastAPI backend running on port 8000 and a valid API key.';
});
photo.addEventListener('change', () => selectFile(photo.files?.[0] ?? null));
clear.addEventListener('click', () => selectFile(null));
dropzone.addEventListener('dragover', event => { event.preventDefault(); dropzone.classList.add('dragging'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', event => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  selectFile(event.dataTransfer?.files[0] ?? null);
});

analyze.addEventListener('click', async () => {
  if (!selected) return;
  const file = selected;
  const id = ++requestId;
  controller?.abort();
  controller = new AbortController();
  analyzing = true;
  analyze.disabled = true;
  analyze.textContent = 'Analyzing…';
  resetAnalysis();
  message(mode.value === 'local' ? 'Analyzing pixels locally. Your photo stays in this browser.' : 'Contacting the vision API…');
  try {
    let payload: unknown;
    if (mode.value === 'local') {
      payload = await analyzeImageLocally(file);
    } else {
      const form = new FormData();
      form.append('file', file, file.name);
      const response = await fetch('/api/analyze', { method: 'POST', body: form, signal: controller.signal });
      payload = await response.json();
      if (!response.ok) {
        const body = payload as { detail?: unknown } | null;
        throw new Error(typeof body?.detail === 'string' ? body.detail : 'Analysis failed (HTTP ' + response.status + ').');
      }
    }
    if (id !== requestId) return;
    if (!isAnalysis(payload)) throw new Error('Analysis response did not match the visual score contract.');
    renderAnalysis(payload);
    if (mode.value === 'local') message('Offline analysis complete (approximate visual estimates). Press Play to hear the soundtrack.');
  } catch (err) {
    if (id !== requestId || (err instanceof DOMException && err.name === 'AbortError')) return;
    message(err instanceof Error ? err.message : 'Could not analyze image. Check that the backend is running.', true);
  } finally {
    if (id === requestId) {
      controller = null;
      analyzing = false;
      analyze.disabled = !selected;
      analyze.textContent = 'Analyze photograph →';
    }
  }
});

play.addEventListener('click', async () => {
  if (!currentAnalysis) return;
  play.disabled = true;
  message('Preparing your composition…');
  try {
    await playFromAnalysis(currentAnalysis);
    if (isPlaying()) {
      stop.disabled = false;
      play.textContent = '↻ Replay composition';
      message('Playing your city soundtrack.');
    } else {
      play.disabled = false;
    }
  } catch (err) {
    stopPlayback();
    stop.disabled = true;
    message(err instanceof Error ? 'Audio could not start: ' + err.message : 'Audio could not start.', true);
  } finally {
    play.disabled = currentAnalysis === null;
  }
});
stop.addEventListener('click', () => {
  stopPlayback();
  stop.disabled = true;
  message('Playback stopped.');
});
onPlaybackEnded(() => { stop.disabled = true; message('Your composition has finished. Replay it anytime.'); });
window.addEventListener('beforeunload', () => { controller?.abort(); stopPlayback(); if (objectUrl) URL.revokeObjectURL(objectUrl); });
