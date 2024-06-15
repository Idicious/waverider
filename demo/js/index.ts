import { WaveShaper, Track, Interval } from "../../src";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
if (canvas == null) throw new Error("Canvas not found");

export let trackData: Track[] = [
  { id: crypto.randomUUID(), name: "Kick", color: "red" },
  { id: crypto.randomUUID(), name: "Snare", color: "teal" },
];

export let audioData = [
  { id: crypto.randomUUID(), file: "audio/01_Kick.wav" },
  { id: crypto.randomUUID(), file: "audio/02_Snare.wav" },
];

export let intervalData: Interval[] = [
  {
    start: 0,
    offsetStart: 0,
    end: 19000,
    index: 0,
    id: crypto.randomUUID(),
    track: trackData[0].id,
    data: audioData[0].id,
  },
  {
    start: 0,
    offsetStart: 0,
    end: 19000,
    index: 0,
    id: crypto.randomUUID(),
    track: trackData[1].id,
    data: audioData[1].id,
  },
];

const waveShaper = new WaveShaper(800, 600, 100, canvas, {
  intervals: intervalData,
  tracks: trackData,
});
waveShaper.process();
waveShaper.run();
