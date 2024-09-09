import { expect, Page } from "@playwright/test";
import { ScaleBand, scaleBand, ScaleLinear, scaleLinear } from "d3";
import { Interval, ScaleData, WaveShaperState } from "src/types";
import { invertYScale } from "src/utils";

export const RESIZE_HANDLE_WIDTH = 5;

export async function loadPage(page: Page) {
  await page.goto("http://localhost:5173");
  const canvas = await page.$("canvas");

  expect(canvas).not.toBeNull();
  return canvas;
}

export async function zoom(page: Page, location: Location, level: number) {
  const { xScale, yScale } = await getScales(page);
  const coords = getCoordinates(location, xScale, yScale);

  page.mouse.move(coords.x, coords.y);

  await page.keyboard.down("ControlOrMeta");
  await page.mouse.wheel(0, level);
  await page.keyboard.up("ControlOrMeta");
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
  const yScale = scaleBand(y.domain, y.range);

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
  await page.keyboard.down("ControlOrMeta");

  await drag(page, start, end);

  await page.keyboard.up("ControlOrMeta");
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

  await page.keyboard.down("ControlOrMeta");
  await canvas!.click({ button: "left", position: { x, y } });
  await page.keyboard.up("ControlOrMeta");
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

  await page.keyboard.down("ControlOrMeta");
  await canvas!.click({ button: "left", position });
  await page.keyboard.up("ControlOrMeta");
}
