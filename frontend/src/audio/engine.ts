/**
 * Sonic Postcodes: Tone.js playback engine (Stream 2).
 *
 * Public API (contract with Developer 3, do not rename):
 *   playFromAnalysis(analysis): Promise<void>
 *   stopPlayback(): void
 *   getMusicDescription(analysis): { bpm, mood, explanation }
 * Small extras (tell Dev 3): isPlaying(), onPlaybackEnded(cb)
 *
 * Rules this file follows:
 *  - nothing happens on import (no autoplay, no AudioContext work)
 *  - Tone.start() is the first thing playFromAnalysis does, so call it directly from a click handler
 *  - every Play builds a fresh, isolated "session" of instruments; Stop/Play fades and disposes the old one
 *  - rapid repeated Play clicks: only the newest call survives (token check after each await)
 */
import * as Tone from "tone";
import type { VisualAnalysis } from "../types/analysis";
import { describePlan, planComposition, type CompositionPlan, type NoteEvent } from "./compose";

const TAIL_SEC = 3.5; // let the reverb ring out after the last note
const FADE_SEC = 0.15;

interface Disposable {
  dispose(): unknown;
}

interface Session {
  nodes: Disposable[];
  master: Tone.Volume;
  endTimer: ReturnType<typeof setTimeout> | null;
}

let session: Session | null = null;
let token = 0;
const endListeners = new Set<() => void>();

// ------------------------------------------------------------------ public API

export function getMusicDescription(analysis: VisualAnalysis): { bpm: number; mood: string; explanation: string } {
  const plan = planComposition(analysis);
  const d = describePlan(plan);
  return { bpm: plan.bpm, mood: d.mood, explanation: d.explanation };
}

export function isPlaying(): boolean {
  return session !== null;
}

/** Called when a piece finishes naturally (not when stopPlayback() is called). Returns an unsubscribe fn. */
export function onPlaybackEnded(cb: () => void): () => void {
  endListeners.add(cb);
  return () => endListeners.delete(cb);
}

export async function playFromAnalysis(analysis: VisualAnalysis): Promise<void> {
  // 1. Must be first: resumes the AudioContext inside the user's click.
  const started = Tone.start();

  // 2. Cancel anything already playing and invalidate older in-flight calls.
  stopPlayback();
  const myToken = token;

  await started;
  if (myToken !== token) return;

  const plan = planComposition(analysis);
  const nodes: Disposable[] = [];
  const track = <T extends Disposable>(n: T): T => (nodes.push(n), n);

  try {
    const reverb = track(new Tone.Reverb({ decay: plan.timbre.reverbDecaySec, wet: plan.timbre.reverbWet }));
    await reverb.generate();
    if (myToken !== token) {
      disposeAll(nodes);
      return;
    }

    const instruments = buildInstruments(plan, reverb, track);

    // reset the transport BEFORE scheduling (cancel() would wipe new events)
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel(0);
    transport.position = 0;
    transport.bpm.value = plan.bpm;

    scheduleEvents(plan, instruments);

    const endTimer = setTimeout(() => finishNaturally(myToken), (plan.durationSec + TAIL_SEC) * 1000);
    session = { nodes, master: instruments.master, endTimer };
    transport.start("+0.1");
  } catch (err) {
    disposeAll(nodes);
    if (myToken === token) session = null;
    throw err;
  }
}

export function stopPlayback(): void {
  token++; // invalidates any playFromAnalysis still awaiting
  const old = session;
  session = null;

  try {
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel(0);
  } catch {
    /* context not created yet: nothing to stop */
  }

  if (old) {
    if (old.endTimer) clearTimeout(old.endTimer);
    try {
      old.master.volume.rampTo(-60, FADE_SEC);
    } catch {
      /* ignore */
    }
    setTimeout(() => disposeAll(old.nodes), FADE_SEC * 1000 + 150);
  }
}

// ------------------------------------------------------------------ internals

function finishNaturally(myToken: number) {
  if (myToken !== token) return;
  stopPlayback();
  endListeners.forEach((cb) => {
    try {
      cb();
    } catch {
      /* listener errors must not break audio */
    }
  });
}

function disposeAll(nodes: Disposable[]) {
  for (const n of nodes) {
    try {
      n.dispose();
    } catch {
      /* already disposed */
    }
  }
}

interface Instruments {
  master: Tone.Volume;
  pad: Tone.PolySynth;
  strings: Tone.PolySynth;
  bass: Tone.PolySynth;
  melody: Tone.PolySynth;
  arp: Tone.PolySynth;
  shimmer: Tone.PolySynth;
  kick: Tone.MembraneSynth;
  snare: Tone.NoiseSynth;
  hat: Tone.NoiseSynth;
}

function buildInstruments(plan: CompositionPlan, reverb: Tone.Reverb, track: <T extends Disposable>(n: T) => T): Instruments {
  const t = plan.timbre;

  // master chain: musicBus -> reverb -> compressor; drumBus -> compressor
  const master = track(new Tone.Volume(-3));
  const limiter = track(new Tone.Limiter(-1));
  const comp = track(new Tone.Compressor({ threshold: -18, ratio: 3, attack: 0.03, release: 0.25 }));
  comp.chain(limiter, master);
  master.toDestination();

  const musicBus = track(new Tone.Gain(1));
  musicBus.chain(reverb, comp);
  const drumBus = track(new Tone.Gain(1));
  drumBus.connect(comp);

  const lp = (hz: number) => track(new Tone.Filter({ frequency: hz, type: "lowpass", rolloff: -24 }));

  const pad = track(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: t.padWave },
      envelope: { attack: t.padAttackSec, decay: 0.6, sustain: 0.8, release: 2.5 },
      volume: -14,
    })
  );
  pad.chain(lp(Math.min(t.filterHz, 3500)), musicBus);

  const strings = track(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 1.8, decay: 0.5, sustain: 0.85, release: 3 },
      volume: -21,
    })
  );
  strings.chain(lp(Math.min(t.filterHz * 0.8, 3000)), musicBus);

  const bass = track(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.02, decay: 0.25, sustain: 0.7, release: 0.5 },
      volume: -10,
    })
  );
  bass.chain(lp(450), musicBus);

  const melody = track(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: t.melodyWave },
      envelope: { attack: 0.02, decay: 0.3, sustain: 0.4, release: 1.2 },
      volume: -13,
    })
  );
  const echo = track(new Tone.FeedbackDelay(plan.secondsPerBeat * 0.75, 0.3));
  echo.wet.value = t.echoWet;
  melody.chain(lp(Math.min(t.filterHz * 1.4, 9000)), echo, musicBus);

  const arp = track(
    new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "square" },
      envelope: { attack: 0.005, decay: 0.15, sustain: 0.05, release: 0.2 },
      volume: -23,
    })
  );
  arp.chain(lp(t.filterHz), musicBus);

  const shimmer = track(
    new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.01,
      modulationIndex: 6,
      envelope: { attack: 0.01, decay: 1.2, sustain: 0, release: 2 },
      modulationEnvelope: { attack: 0.01, decay: 0.5, sustain: 0, release: 1 },
      volume: -26,
    })
  );
  shimmer.connect(musicBus);

  const kick = track(
    new Tone.MembraneSynth({
      pitchDecay: 0.04,
      octaves: 6,
      envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.2 },
      volume: -6,
    })
  );
  kick.connect(drumBus);

  const snare = track(new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.15, sustain: 0 }, volume: -16 }));
  snare.chain(track(new Tone.Filter({ frequency: 1500, type: "highpass" })), drumBus);

  const hat = track(new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.04, sustain: 0 }, volume: -28 }));
  hat.chain(track(new Tone.Filter({ frequency: 7000, type: "highpass" })), drumBus);

  return { master, pad, strings, bass, melody, arp, shimmer, kick, snare, hat };
}

function scheduleEvents(plan: CompositionPlan, ins: Instruments) {
  const transport = Tone.getTransport();
  const spb = plan.secondsPerBeat;
  const freq = (midi: number) => Tone.Midi(midi).toFrequency();

  const play = (e: NoteEvent, time: number) => {
    const dur = Math.max(0.05, e.duration * spb);
    switch (e.layer) {
      case "pad": ins.pad.triggerAttackRelease(freq(e.midi), dur, time, e.velocity); break;
      case "strings": ins.strings.triggerAttackRelease(freq(e.midi), dur, time, e.velocity); break;
      case "bass": ins.bass.triggerAttackRelease(freq(e.midi), dur, time, e.velocity); break;
      case "melody": ins.melody.triggerAttackRelease(freq(e.midi), dur, time, e.velocity); break;
      case "arp": ins.arp.triggerAttackRelease(freq(e.midi), dur, time, e.velocity); break;
      case "shimmer": ins.shimmer.triggerAttackRelease(freq(e.midi), dur, time, e.velocity); break;
      case "kick": ins.kick.triggerAttackRelease("C1", 0.2, time, e.velocity); break;
      case "snare": ins.snare.triggerAttackRelease(0.15, time, e.velocity); break;
      case "hat": ins.hat.triggerAttackRelease(0.05, time, e.velocity); break;
    }
  };

  for (const e of plan.events) {
    transport.schedule((time) => play(e, time), e.time * spb);
  }
}

// Dev-server hot reload: never leave a previous module instance's audio running.
(import.meta as unknown as { hot?: { dispose(cb: () => void): void } }).hot?.dispose(() => stopPlayback());
