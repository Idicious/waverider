import { WaveShaper } from "../../src";
import { DataLoader } from "./data-loader";
import type ApiResponse from "../data/session.json";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;

(async function main() {
  const dataLoader = new DataLoader();
  const ctx = new AudioContext();

  const { configuration, intervals, tracks, audio }: typeof ApiResponse =
    await fetch("data/session.json").then((res) => res.json());

  const audioData = await dataLoader.load(audio, ctx);

  const waveShaper = new WaveShaper(
    configuration.width,
    configuration.height,
    configuration.trackHeight,
    canvas,
    {
      intervals,
      tracks,
      audioData,
    }
  );

  (globalThis as any)["WaveShaper"] = waveShaper;

  waveShaper.process();
  waveShaper.run();
})();
