import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { scaleBand, scaleLinear } from "d3";
import type { ScaleBand, ScaleLinear } from "d3";
import { fileURLToPath } from "node:url";
import type { Interval, ScaleData, WaveShaperState } from "src/types";
import { invertYScale } from "src/utils";

export const RESIZE_HANDLE_WIDTH = 5;

/**
 * Vite serves modules from outside its root under /@fs, which lets a browser
 * test import library code directly instead of reaching it through the demo.
 */
export const AUDIO_MODULE_URL =
  "/@fs" + fileURLToPath(new URL("../src/audio.ts", import.meta.url));

export async function loadPage(page: Page) {
  await page.goto("/");
  const canvas = await page.$("canvas");

  expect(canvas).not.toBeNull();
  await waitForRender(page);

  return canvas;
}

/**
 * The demo decodes its audio before it constructs a WaveShaper, so the canvas
 * is still blank for a while after the page loads. Wait for the first frame
 * rather than racing it.
 */
export async function waitForRender(page: Page) {
  await page.waitForFunction(() => {
    if ((globalThis as any)["WaveShaper"] == null) return false;

    const canvas = document.querySelector("canvas");
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (canvas == null || context == null) return false;

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true;
    }

    return false;
  });
}

export async function zoom(page: Page, location: Location, level: number) {
  const { xScale, yScale } = await getScales(page);
  const coords = getCoordinates(location, xScale, yScale);

  await page.mouse.move(coords.x, coords.y);

  // the zoom behaviour filters on metaKey, so press Meta rather than
  // ControlOrMeta - the latter maps to Control off macOS and does nothing
  await page.keyboard.down("Meta");
  await page.mouse.wheel(0, level);
  await page.keyboard.up("Meta");
}

export async function expectScreenshot(page: Page) {
  const screenshot = await page.screenshot();
  expect(screenshot).toMatchSnapshot();
}

export async function getScales(page: Page) {
  let { x, y }: ScaleData = await page.evaluate(() => {
    const waveShaper = (globalThis as any)["WaveShaper"];
    return waveShaper.getScaleData();
  });

  const xScale = scaleLinear(x.domain, x.range);
  const yScale = scaleBand(y.domain, y.range).padding(y.padding);

  return { xScale, yScale };
}

export async function getState(page: Page): Promise<WaveShaperState> {
  return page.evaluate(() => {
    const waveShaper = (globalThis as any)["WaveShaper"];
    return waveShaper.getState();
  });
}

export interface Coordinates {
  x: number;
  y: number;
}

export interface Location {
  track: string;
  time: number;
}

export function getCoordinates(
  location: Location,
  xScale: ScaleLinear<number, number>,
  yScale: ScaleBand<string>
): Coordinates {
  return { x: xScale(location.time), y: yScale(location.track) ?? 0 };
}

export function getLocationFromCoordinates(
  coordinates: Coordinates,
  xScale: ScaleLinear<number, number>,
  yScale: ScaleBand<string>
): Location {
  return {
    time: xScale.invert(coordinates.x),
    track: invertYScale(yScale, coordinates.y),
  };
}

export type Mode = "drag" | "resize" | "cut";

export async function getLocationFromInterval(
  interval: Interval,
  mode: Mode,
  xScale: ScaleLinear<number, number>
): Promise<Location> {
  const offsetStart = mode === "drag" ? xScale(RESIZE_HANDLE_WIDTH) : 0;

  return {
    time: interval.start + interval.offsetStart + offsetStart,
    track: interval.track,
  };
}

export async function drag(page: Page, start: Location, end: Location) {
  const canvas = await page.$("canvas");
  const { xScale, yScale } = await getScales(page);

  const startPosition = getCoordinates(start, xScale, yScale);
  const endPosition = getCoordinates(end, xScale, yScale);

  await canvas?.hover({ position: startPosition });
  await page.mouse.down();
  await canvas?.hover({ position: endPosition });
  await page.mouse.up();
}

export async function pan(page: Page, start: Location, end: Location) {
  await page.keyboard.down("Meta");

  await drag(page, start, end);

  await page.keyboard.up("Meta");
}

export async function moveInterval(
  page: Page,
  interval: Interval,
  endLocation: Location
) {
  const { xScale } = await getScales(page);
  const startLocation = await getLocationFromInterval(interval, "drag", xScale);

  endLocation.time = endLocation.time + xScale(RESIZE_HANDLE_WIDTH);
  await drag(page, startLocation, endLocation);
}

export async function cutLocation(page: Page, location: Location) {
  const { xScale, yScale } = await getScales(page);
  const canvas = await page.$("canvas");

  const x = xScale(location.time);
  const y = yScale(location.track);

  if (y == null) {
    throw new Error("track not found");
  }

  // the renderer checks metaKey, so press Meta rather than ControlOrMeta -
  // the latter maps to Control off macOS and never triggers a cut
  await page.keyboard.down("Meta");
  await canvas!.click({ button: "left", position: { x, y } });
  await page.keyboard.up("Meta");
}

export async function cutInterval(
  page: Page,
  interval: Interval,
  time: number
) {
  const { xScale, yScale } = await getScales(page);
  const canvas = await page.$("canvas");

  if (time < interval.offsetStart + xScale(RESIZE_HANDLE_WIDTH)) {
    throw new Error(
      "cut time must be greater than offset start + resize handle width"
    );
  }

  const location = await getLocationFromInterval(interval, "cut", xScale);
  location.time += time;

  const position = getCoordinates(location, xScale, yScale);

  await page.keyboard.down("Meta");
  await canvas!.click({ button: "left", position });
  await page.keyboard.up("Meta");
}
