/**
 * Sonic Postcodes: composition planner (Stream 2, Musical Intelligence).
 *
 * PURE module: no Tone.js, no browser APIs, no randomness except a seeded PRNG.
 * Same VisualAnalysis in => identical CompositionPlan out.
 *
 * Mapping summary
 *   grandeur   -> open/spread voicings, deeper bass + sub, sustained strings, reverb size,
 *                 rising melody at the peak, bigger crescendo depth
 *   energy     -> BPM, rhythmic subdivision of bass / melody / arp, drum patterns
 *   brightness -> melody + arp register (in scale degrees, so always in key), filter cutoff,
 *                 sparkling "shimmer" layer
 *   density    -> number of simultaneous layers (arp, percussion, shimmer)
 *   warmth     -> mode (major/lydian vs dorian vs minor), key centre, wave shape,
 *                 chord colour (added 7ths vs hollow open fifths)
 */
import type { VisualAnalysis } from "../types/analysis";

// ---------------------------------------------------------------- types

export type SectionName = "intro" | "build" | "peak" | "resolution";
export type ModeName = "ionian" | "lydian" | "dorian" | "aeolian";
export type LogicalLayer = "pad" | "bass" | "melody" | "strings" | "percussion" | "arp" | "shimmer";
export type EventLayer = "pad" | "strings" | "bass" | "melody" | "arp" | "shimmer" | "kick" | "snare" | "hat";

export interface NoteEvent {
  layer: EventLayer;
  /** start, in beats from the beginning of the piece */
  time: number;
  /** length, in beats */
  duration: number;
  /** MIDI note number (ignored for snare/hat) */
  midi: number;
  /** 0..1 */
  velocity: number;
}

export interface Section {
  name: SectionName;
  startBar: number;
  bars: number;
}

export interface Timbre {
  padWave: "triangle" | "sawtooth";
  melodyWave: "triangle" | "square";
  /** low-pass cutoff for melodic layers, Hz */
  filterHz: number;
  reverbDecaySec: number;
  /** 0..1 reverb wet mix */
  reverbWet: number;
  /** pad attack, seconds (slower for grand scenes) */
  padAttackSec: number;
  /** feedback-delay wet, 0..1 */
  echoWet: number;
}

export interface Influence {
  attribute: "grandeur" | "energy" | "brightness" | "density" | "warmth";
  value: number;
  effect: string;
}

export interface CompositionPlan {
  scores: Scores;
  bpm: number;
  beatsPerBar: 4;
  bars: number;
  totalBeats: number;
  durationSec: number;
  secondsPerBeat: number;
  keyName: string;
  rootPc: number;
  mode: ModeName;
  scale: number[];
  /** scale degree (0-6) of the chord used in each bar */
  progression: number[];
  sections: Section[];
  layers: LogicalLayer[];
  timbre: Timbre;
  events: NoteEvent[];
  mood: string;
  explanation: string;
  influences: Influence[];
}

export interface Scores {
  grandeur: number;
  energy: number;
  brightness: number;
  density: number;
  warmth: number;
}

// ---------------------------------------------------------------- helpers

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const clamp01 = (n: number) => (Number.isFinite(n) ? clamp(n, 0, 1) : 0.5);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function normaliseScores(raw: Partial<Record<keyof Scores, number>> | undefined): Scores {
  return {
    grandeur: clamp01(raw?.grandeur as number),
    energy: clamp01(raw?.energy as number),
    brightness: clamp01(raw?.brightness as number),
    density: clamp01(raw?.density as number),
    warmth: clamp01(raw?.warmth as number),
  };
}

function seedFrom(s: Scores): number {
  let h = 2166136261;
  for (const v of [s.grandeur, s.energy, s.brightness, s.density, s.warmth]) {
    h ^= Math.round(v * 100);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

const SCALES: Record<ModeName, number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
};

/** 4-chord loops as 0-based scale degrees. Index 0 = "epic", 1 = driving, 2 = gentle. */
const PROGRESSIONS: Record<ModeName, number[][]> = {
  ionian: [[0, 4, 5, 3], [0, 3, 4, 3], [0, 5, 3, 4]],
  lydian: [[0, 1, 4, 0], [0, 4, 1, 0], [0, 1, 0, 4]],
  dorian: [[0, 6, 3, 0], [0, 3, 6, 3], [0, 3, 0, 4]],
  aeolian: [[0, 5, 2, 6], [0, 6, 5, 6], [0, 3, 6, 2]],
};

/** Melodic contours as offsets (in scale steps) from the current chord root. Repeated every bar = a motif. */
const CONTOURS: number[][] = [
  [0, 2, 4, 2, 0, 2, 4, 5],
  [4, 2, 0, 1, 2, 4, 5, 4],
  [0, 1, 2, 4, 2, 1, 0, 2],
];

/** Semitones above the tonic for scale degree `deg` (may be negative or >6). */
function degreeSemis(scale: number[], deg: number): number {
  const oct = Math.floor(deg / 7);
  const idx = ((deg % 7) + 7) % 7;
  return scale[idx] + 12 * oct;
}

const tonicMidi = (pc: number, octave: number) => 12 * (octave + 1) + pc;

function foldInto(midi: number, lo: number, hi: number): number {
  let m = midi;
  while (m > hi) m -= 12;
  while (m < lo) m += 12;
  return m;
}

// ---------------------------------------------------------------- planner

export function planComposition(analysis: VisualAnalysis): CompositionPlan {
  const s = normaliseScores(analysis?.scores);
  const rand = mulberry32(seedFrom(s));

  // --- tempo & length (always ~24-28 s)
  const bpm = Math.round(clamp(60 + s.energy * 72 - s.grandeur * 8, 56, 132));
  const bars = clamp(Math.round((26 * bpm) / 240), 6, 14);
  const totalBeats = bars * 4;
  const secondsPerBeat = 60 / bpm;
  const durationSec = r4(totalBeats * secondsPerBeat);

  // --- key & mode (warmth)
  const mode: ModeName =
    s.warmth >= 0.65 ? (s.brightness >= 0.65 ? "lydian" : "ionian") : s.warmth >= 0.4 ? "dorian" : "aeolian";
  const scale = SCALES[mode];
  const ROOTS = [9, 2, 4, 0, 7, 5]; // A D E C G F : cool/dark -> warm/open
  const rootPc = ROOTS[Math.min(5, Math.floor(s.warmth * 6))];
  const keyName = `${NOTE_NAMES[rootPc]} ${mode === "ionian" ? "major" : mode === "aeolian" ? "minor" : mode}`;

  // --- harmony
  const loops = PROGRESSIONS[mode];
  const loop = loops[s.grandeur >= 0.6 ? 0 : s.energy >= 0.5 ? 1 : 2];
  const progression = Array.from({ length: bars }, (_, b) => loop[b % 4]);
  progression[bars - 1] = 0; // resolve home

  // --- form
  const intro = Math.max(1, Math.floor(bars * 0.25));
  const build = Math.max(1, Math.floor(bars * 0.25));
  const resolution = Math.max(1, Math.round(bars * 0.15));
  const peak = bars - intro - build - resolution;
  const sections: Section[] = [
    { name: "intro", startBar: 0, bars: intro },
    { name: "build", startBar: intro, bars: build },
    { name: "peak", startBar: intro + build, bars: peak },
    { name: "resolution", startBar: intro + build + peak, bars: resolution },
  ];
  const sectionOf = (bar: number) => sections.find((x) => bar >= x.startBar && bar < x.startBar + x.bars)!;

  // --- layer selection (density / grandeur / energy / brightness)
  const wantExtras = Math.round(s.density * 3);
  const candidates = s.energy >= 0.2 ? ["perc", "arp", "shimmer"] : ["arp", "shimmer"];
  const chosen = candidates.slice(0, wantExtras);
  const stringsOn = s.grandeur >= 0.5;
  const percOn = chosen.includes("perc") || s.energy >= 0.6;
  const arpOn = chosen.includes("arp");
  const shimmerOn = chosen.includes("shimmer") || s.brightness >= 0.75;
  const layers: LogicalLayer[] = ["pad", "bass", "melody"];
  if (stringsOn) layers.push("strings");
  if (percOn) layers.push("percussion");
  if (arpOn) layers.push("arp");
  if (shimmerOn) layers.push("shimmer");

  // --- timbre
  const filterHz = Math.round(clamp(500 * Math.pow(2, 3.6 * s.brightness) * (1.3 - 0.6 * s.warmth), 400, 9000));
  const timbre: Timbre = {
    padWave: s.warmth >= 0.55 ? "triangle" : "sawtooth",
    melodyWave: s.warmth >= 0.5 ? "triangle" : "square",
    filterHz,
    reverbDecaySec: r4(1.5 + 4 * s.grandeur),
    reverbWet: r4(0.2 + 0.35 * s.grandeur),
    padAttackSec: r4(0.5 + 1.5 * s.grandeur),
    echoWet: r4(0.15 + 0.15 * s.grandeur),
  };

  // --- dynamics: crescendo whose depth grows with grandeur
  const depth = 0.35 + 0.65 * s.grandeur;
  const intensityAt = (bar: number): number => {
    const sec = sectionOf(bar);
    const p = (bar - sec.startBar + 0.5) / sec.bars;
    const dyn =
      sec.name === "intro" ? lerp(0.3, 0.45, p)
      : sec.name === "build" ? lerp(0.45, 0.8, p)
      : sec.name === "peak" ? lerp(0.85, 1.0, p)
      : lerp(0.6, 0.25, p);
    return 1 - depth * (1 - dyn);
  };

  // --- event generation
  const events: NoteEvent[] = [];
  const add = (layer: EventLayer, bar: number, beat: number, duration: number, midi: number, vel: number) => {
    events.push({
      layer,
      time: r4(bar * 4 + beat),
      duration: r4(duration),
      midi,
      velocity: r4(clamp(vel, 0.05, 1)),
    });
  };

  const contour = CONTOURS[Math.floor(rand() * CONTOURS.length)];
  const energyLevel = s.energy < 0.35 ? 0 : s.energy < 0.7 ? 1 : 2;
  const brightShift = Math.round((s.brightness - 0.5) * 8) + (s.brightness >= 0.75 ? 7 : 0); // scale steps
  const open = s.grandeur >= 0.55;

  // rhythmic templates: [beat, length]
  const MELODY_RHYTHMS: Array<Array<[number, number]>> = [
    [[0, 2], [2, 1.5]],
    [[0, 1.5], [1.5, 0.5], [2, 1], [3, 1]],
    [[0, 0.75], [0.75, 0.75], [1.5, 0.5], [2, 0.5], [2.5, 0.5], [3, 0.5], [3.5, 0.5]],
  ];

  for (let bar = 0; bar < bars; bar++) {
    const sec = sectionOf(bar);
    const local = bar - sec.startBar;
    const lastBar = bar === bars - 1;
    const inten = intensityAt(bar);
    const d = progression[bar];
    const iv = (k: number) => degreeSemis(scale, d + k) - degreeSemis(scale, d);
    let r = degreeSemis(scale, d);
    if (r > 6) r -= 12; // keep chord roots near the tonic

    // ---- pad (harmonic layer)
    {
      const third = iv(2), fifth = iv(4), seventh = iv(6), ninth = iv(8);
      let voicing: number[];
      if (open) {
        voicing = [0, fifth, 12 + third, 12 + (s.warmth >= 0.5 ? seventh : 0)];
        if (s.grandeur >= 0.8) voicing = [-12, ...voicing, 12 + ninth];
      } else if (s.warmth >= 0.6) voicing = [0, third, fifth, seventh];
      else if (s.warmth < 0.4) voicing = [0, fifth, 12];
      else voicing = [0, third, fifth];
      const base = tonicMidi(rootPc, 3) + r;
      for (const off of Array.from(new Set(voicing)).sort((a, b) => a - b)) {
        add("pad", bar, 0, lastBar ? 4 : 4.25, base + off, 0.42 * inten);
      }
    }

    // ---- strings: sustained upper swell (grandeur)
    if (stringsOn && sec.name !== "intro" && !(sec.name === "resolution" && local > 0)) {
      const third = iv(2), fifth = iv(4);
      const base = tonicMidi(rootPc, 3) + r;
      for (const off of [12 + third, 12 + fifth, 24]) {
        add("strings", bar, 0, 4.25, base + off, 0.34 * inten);
      }
    }

    // ---- bass
    {
      const base = tonicMidi(rootPc, 2) + r;
      const lowered = base - 12;
      const root = s.grandeur >= 0.6 && lowered >= 30 ? lowered : base;
      const fifthSemis = iv(4);
      const bassLevel = sec.name === "intro" ? (stringsOn ? 0 : -1) : sec.name === "resolution" ? 0 : energyLevel;
      if (bassLevel >= 0) {
        const bv = 0.6 * inten;
        if (bassLevel === 0 || lastBar) add("bass", bar, 0, lastBar ? 4 : 3.9, root, bv);
        else if (bassLevel === 1) {
          add("bass", bar, 0, 1.9, root, bv);
          add("bass", bar, 2, 1.9, root + (rand() < 0.5 ? 0 : fifthSemis), bv * 0.85);
        } else {
          for (let i = 0; i < 8; i++) {
            const up = i % 4 === 3;
            add("bass", bar, i * 0.5, 0.45, root + (up ? fifthSemis : 0), bv * (i % 2 === 0 ? 1 : 0.7));
          }
        }
        if (s.grandeur >= 0.6 && root - 12 >= 28 && !lastBar) add("bass", bar, 0, 3.9, root - 12, bv * 0.5);
      }
    }

    // ---- melody (always present; sparse in intro/resolution)
    {
      const level = sec.name === "intro" || sec.name === "resolution" ? 0 : sec.name === "build" ? Math.min(energyLevel, s.energy >= 0.7 ? 2 : 1) : energyLevel;
      const rise =
        sec.name === "peak" && s.grandeur >= 0.5 ? 2 : sec.name === "build" && s.grandeur >= 0.5 && local >= sec.bars / 2 ? 1 : 0;
      const skip = s.energy < 0.25 && bar % 2 === 1 && sec.name !== "peak";
      const baseDeg = brightShift + rise;
      const midiFor = (offset: number) => foldInto(tonicMidi(rootPc, 4) + degreeSemis(scale, baseDeg + d + offset), 48, 88);
      if (lastBar) {
        add("melody", bar, 0, 4, foldInto(tonicMidi(rootPc, 4) + degreeSemis(scale, brightShift), 52, 88), 0.5 * inten);
      } else if (!skip) {
        MELODY_RHYTHMS[level].forEach(([beat, len], i) => {
          add("melody", bar, beat, len * 0.95, midiFor(contour[i % contour.length]), (i === 0 ? 0.7 : 0.55) * inten);
        });
        if (sec.name === "peak" && s.grandeur >= 0.7) add("melody", bar, 0, 3.5, midiFor(contour[0]) - 12, 0.3 * inten);
      }
    }

    // ---- arpeggio
    if (arpOn && (sec.name === "build" || sec.name === "peak")) {
      const step = s.energy >= 0.65 && sec.name === "peak" ? 0.25 : 0.5;
      const shape = [0, 2, 4, 7, 4, 2];
      const baseDeg = brightShift + d;
      for (let i = 0; i < 4 / step; i++) {
        const midi = foldInto(tonicMidi(rootPc, 4) + degreeSemis(scale, baseDeg + shape[i % shape.length]), 55, 90);
        add("arp", bar, i * step, step * 0.9, midi, (i % 4 === 0 ? 0.36 : 0.26) * inten);
      }
    }

    // ---- shimmer (bell-like sparkle)
    if (shimmerOn && (sec.name === "peak" || (sec.name === "resolution" && local === 0))) {
      const beats = s.brightness >= 0.75 ? [0.5, 1.5, 2.5, 3.5] : [1.5, 3.5];
      beats.forEach((beat, k) => {
        const midi = foldInto(tonicMidi(rootPc, 6) + degreeSemis(scale, d + [4, 2, 7, 4][k % 4]), 84, 100);
        add("shimmer", bar, beat, 2, midi, 0.3 * inten);
      });
    }

    // ---- percussion
    if (percOn) {
      const kick = (b: number, v = 0.9) => add("kick", bar, b, 0.4, 36, v * inten);
      const snare = (b: number, v = 0.6) => add("snare", bar, b, 0.2, 38, v * inten);
      const hat = (b: number, v = 0.35) => add("hat", bar, b, 0.1, 42, v * inten);
      const lastOfBuild = sec.name === "build" && local === sec.bars - 1;
      if (sec.name === "build") {
        kick(0);
        if (s.energy >= 0.25) kick(2, 0.7);
        if (s.energy >= 0.5) [0.5, 1.5, 2.5, 3.5].forEach((b) => hat(b, 0.25));
        if (lastOfBuild && s.energy >= 0.25) {
          const hits = s.energy >= 0.6 ? 8 : 4;
          for (let i = 0; i < hits; i++) snare(4 - (hits - i) * 0.5, 0.3 + 0.5 * (i / hits));
        }
      } else if (sec.name === "peak") {
        if (energyLevel === 0) kick(0, 0.8);
        else if (energyLevel === 1) {
          kick(0); kick(2, 0.8); snare(1); snare(3);
          [0.5, 1.5, 2.5, 3.5].forEach((b) => hat(b));
        } else {
          [0, 1, 2, 3].forEach((b) => kick(b, b % 2 === 0 ? 1 : 0.8));
          snare(1, 0.7); snare(3, 0.7);
          const hs = s.energy >= 0.85 ? 0.25 : 0.5;
          for (let b = 0; b < 4; b += hs) hat(b, b % 1 === 0 ? 0.3 : 0.4);
        }
      } else if (sec.name === "resolution" && s.energy >= 0.3 && (local === 0 || lastBar)) {
        kick(0, 0.6);
      }
    }
  }

  events.sort((a, b) => a.time - b.time || a.midi - b.midi);

  const plan: CompositionPlan = {
    scores: s,
    bpm,
    beatsPerBar: 4,
    bars,
    totalBeats,
    durationSec,
    secondsPerBeat: r4(secondsPerBeat),
    keyName,
    rootPc,
    mode,
    scale,
    progression,
    sections,
    layers,
    timbre,
    events,
    mood: "",
    explanation: "",
    influences: [],
  };
  const d = describePlan(plan);
  plan.mood = d.mood;
  plan.explanation = d.explanation;
  plan.influences = d.influences;
  return plan;
}

// ---------------------------------------------------------------- description

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function describePlan(plan: CompositionPlan): { mood: string; explanation: string; influences: Influence[] } {
  const s = plan.scores;
  let mood: string;
  if (s.grandeur >= 0.7 && s.energy >= 0.65) mood = "Monumental and relentless";
  else if (s.grandeur >= 0.7 && s.energy < 0.4) mood = "Majestic and still";
  else if (s.grandeur >= 0.7) mood = "Grand and stately";
  else if (s.energy >= 0.65) mood = "Driving and vibrant";
  else if (s.energy < 0.35 && s.grandeur < 0.5) mood = "Quiet and intimate";
  else if (s.energy < 0.35) mood = "Calm and spacious";
  else mood = "Balanced and flowing";
  if (s.brightness >= 0.7) mood += ", luminous";
  else if (s.brightness <= 0.3) mood += ", shadowed";

  const influences: Influence[] = [
    {
      attribute: "grandeur",
      value: s.grandeur,
      effect:
        s.grandeur >= 0.7 ? `Towering scale (${pct(s.grandeur)}) becomes wide open chord voicings, a deep bass with a sub octave, sustained strings and a long crescendo.`
        : s.grandeur >= 0.4 ? `Moderate scale (${pct(s.grandeur)}) gives open chords, sustained strings and a gentle swell.`
        : `Modest scale (${pct(s.grandeur)}) keeps the chords close and intimate with a restrained swell.`,
    },
    {
      attribute: "energy",
      value: s.energy,
      effect:
        s.energy >= 0.65 ? `High energy (${pct(s.energy)}) sets a fast ${plan.bpm} BPM with a pulsing bass, busy melody and driving drums.`
        : s.energy >= 0.35 ? `Moderate energy (${pct(s.energy)}) sets a steady ${plan.bpm} BPM with a light backbeat.`
        : `Low energy (${pct(s.energy)}) sets a slow ${plan.bpm} BPM and leaves long spaces between notes.`,
    },
    {
      attribute: "brightness",
      value: s.brightness,
      effect:
        s.brightness >= 0.7 ? `Bright light (${pct(s.brightness)}) lifts the melody into a high register and adds sparkling bell tones.`
        : s.brightness >= 0.35 ? `Balanced light (${pct(s.brightness)}) keeps the melody in a mid register.`
        : `Dim light (${pct(s.brightness)}) lowers the melody and darkens the tone with a closed filter.`,
    },
    {
      attribute: "density",
      value: s.density,
      effect: `${plan.layers.length} musical layers (${plan.layers.join(", ")}) respond to visual density of ${pct(s.density)}.`,
    },
    {
      attribute: "warmth",
      value: s.warmth,
      effect:
        s.warmth >= 0.65 ? `Warm tones (${pct(s.warmth)}) choose ${plan.keyName} with soft timbres and added sevenths.`
        : s.warmth >= 0.4 ? `Neutral tones (${pct(s.warmth)}) choose ${plan.keyName}, balanced between warm and cool.`
        : `Cool tones (${pct(s.warmth)}) choose ${plan.keyName} with hollow, open fifths and a sharper timbre.`,
    },
  ];
  return { mood, explanation: influences.map((i) => i.effect).join(" "), influences };
}

// ---------------------------------------------------------------- analysis helpers (used by tests / UI)

/** Rhythmic events per second, excluding sustained pad/strings. */
export function rhythmicActivity(plan: CompositionPlan): number {
  const n = plan.events.filter((e) => e.layer !== "pad" && e.layer !== "strings").length;
  return n / plan.durationSec;
}

/** Pitch span in semitones of the pad voicings. */
export function harmonicSpan(plan: CompositionPlan): number {
  const pads = plan.events.filter((e) => e.layer === "pad").map((e) => e.midi);
  return Math.max(...pads) - Math.min(...pads);
}

export function meanPitch(plan: CompositionPlan, layer: EventLayer): number {
  const m = plan.events.filter((e) => e.layer === layer).map((e) => e.midi);
  return m.reduce((a, b) => a + b, 0) / (m.length || 1);
}
