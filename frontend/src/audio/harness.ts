// Standalone listening harness. Open /audio-harness.html in `npm run dev`.
import { getMusicDescription, playFromAnalysis, stopPlayback } from "./engine";
import { NYC_MOCK, SOHO_MOCK } from "./fixtures";

const out = document.getElementById("out")!;
function wire(id: string, a: typeof NYC_MOCK) {
  document.getElementById(id)!.addEventListener("click", () => {
    const d = getMusicDescription(a);
    out.textContent = `${a.scene}\n${d.bpm} BPM, ${d.mood}\n\n${d.explanation}`;
    playFromAnalysis(a).catch((e) => (out.textContent = String(e)));
  });
}
wire("nyc", NYC_MOCK);
wire("soho", SOHO_MOCK);
document.getElementById("stop")!.addEventListener("click", stopPlayback);
