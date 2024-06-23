import { Track, Interval } from "../../src";

export let trackData: Track[] = [
  { id: crypto.randomUUID(), name: "Kick", color: "red" },
  { id: crypto.randomUUID(), name: "Snare", color: "teal" },
];

export let audioFiles = [
  { id: crypto.randomUUID(), file: "audio/kick.wav" },
  { id: crypto.randomUUID(), file: "audio/snare.wav" },
];

export let intervalData: Interval[] = [
  {
    start: 0,
    offsetStart: 0,
    end: 19000,
    index: 0,
    id: crypto.randomUUID(),
    track: trackData[0].id,
    data: audioFiles[0].id,
  },
  {
    start: 0,
    offsetStart: 0,
    end: 19000,
    index: 0,
    id: crypto.randomUUID(),
    track: trackData[1].id,
    data: audioFiles[1].id,
  },
];
