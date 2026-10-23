// Two short synthesized cues, no audio files. Kept deliberately quiet and brief.
//   notify  - soft two-note chime (a student is back, a question round finished)
//   warning - lower double pulse (a student sent an away notice that needs a reply)
// Student answers never play a sound.
const KEY = "iseenta-sounds";
export type SoundName = "notify" | "warning";

let context: AudioContext | null = null;

export const soundsEnabled = () => {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
};
export const setSoundsEnabled = (on: boolean) => {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* storage can be blocked */ }
};

const tone = (ctx: AudioContext, frequency: number, start: number, length: number, type: OscillatorType, peak: number) => {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + length + 0.02);
};

export const playSound = (name: SoundName) => {
  if (!soundsEnabled()) return;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    context = context ?? new Ctor();
    const ctx = context;
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime + 0.02;
    if (name === "notify") {
      tone(ctx, 784, t, 0.22, "sine", 0.09);
      tone(ctx, 1175, t + 0.11, 0.3, "sine", 0.08);
    } else {
      tone(ctx, 392, t, 0.16, "triangle", 0.1);
      tone(ctx, 330, t + 0.2, 0.26, "triangle", 0.1);
    }
  } catch { /* audio is optional */ }
};
