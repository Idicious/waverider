import { WaveShaper } from "../../src";
import { audioFiles, intervalData, trackData } from "./data";
import { DataLoader } from "./data-loader";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const htmlElement = document.getElementById("root") as HTMLElement;

(async function main() {
  const dataLoader = new DataLoader();
  const ctx = new AudioContext();

  const audioData = await dataLoader.load(audioFiles, ctx);

  const waveShaper = new WaveShaper(
    document.body.clientWidth,
    document.body.clientHeight,
    200,
    canvas,
    {
      intervals: intervalData,
      tracks: trackData,
      colorMap: new Map(trackData.map((d) => [d.id, d.color])),
      audioData,
    }
  );

  waveShaper.process();
  waveShaper.run();
})();
