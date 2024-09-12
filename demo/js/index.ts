import { WaveShaper } from "../../src";
import { DataLoader } from "./data-loader";
import type ApiResponse from "../data/session.json";
import type { Automation } from "src/types";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;

(async function main() {
  const dataLoader = new DataLoader();
  const ctx = new AudioContext();

  const {
    configuration,
    intervals,
    tracks,
    audio,
    automation,
    automationData,
  }: typeof ApiResponse = await fetch("data/session.json").then((res) =>
    res.json()
  );

  const audioData = await dataLoader.load(audio, ctx);

  const waveShaper = new WaveShaper(canvas, ctx, {
    intervals,
    tracks,
    audioData,
    automation: automation as Automation[],
    automationData,
    configuration,
  });

  (globalThis as any)["WaveShaper"] = waveShaper;

  waveShaper.process();
  waveShaper.run();
})();
