import { WaveShaper } from "../../src";
import { DataLoader } from "./data-loader";
import type ApiResponse from "../data/session.json";
import type { Automation } from "../../src/types";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const automationCb = document.getElementById("automation") as HTMLInputElement;
const rmsBandCb = document.getElementById("rms-band") as HTMLInputElement;

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

  automationCb.checked = configuration.showAutomation;
  rmsBandCb.checked = configuration.showRmsBand;
  const audioData = await dataLoader.load(audio, ctx);

  const waveShaper = new WaveShaper(canvas, ctx, {
    intervals,
    tracks,
    audioData,
    automation: automation as Automation[],
    automationData,
    configuration,
  });

  automationCb.addEventListener("change", () => {
    const state = waveShaper.getState();
    state.configuration.showAutomation = automationCb.checked;

    waveShaper.updateState(() => [
      { ...state, audioData },
      undefined,
      undefined,
    ]);
  });

  rmsBandCb.addEventListener("change", () => {
    const state = waveShaper.getState();
    state.configuration.showRmsBand = rmsBandCb.checked;

    waveShaper.updateState(() => [
      { ...state, audioData },
      undefined,
      undefined,
    ]);
  });

  (globalThis as any)["WaveShaper"] = waveShaper;

  waveShaper.process();
  waveShaper.run();
})();
