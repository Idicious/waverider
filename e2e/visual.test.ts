import { test, expect } from "@playwright/test";
import { WaveShaperState } from "src/types";

test("basic", async ({ page }) => {
  await page.goto("http://localhost:5173");
  const canvas = await page.$("#canvas");
  expect(canvas).not.toBeNull();

  const screenshot = await page.screenshot();
  expect(screenshot).toMatchSnapshot();
});

test("drag", async ({ page }) => {
  await page.goto("http://localhost:5173");
  const canvas = await page.$("#canvas");
  expect(canvas).not.toBeNull();

  await canvas?.hover({ position: { x: 5, y: 50 } });
  await page.mouse.down();
  await canvas?.hover({ position: { x: 100, y: 50 } });
  await page.mouse.up();

  const screenshot = await page.screenshot();
  expect(screenshot).toMatchSnapshot();
});

test("drag to other track", async ({ page }) => {
  await page.goto("http://localhost:5173");
  const canvas = await page.$("#canvas");
  expect(canvas).not.toBeNull();

  await canvas?.hover({ position: { x: 5, y: 50 } });
  await page.mouse.down();
  await canvas?.hover({ position: { x: 200, y: 250 } });
  await page.mouse.up();

  const screenshot = await page.screenshot();
  expect(screenshot).toMatchSnapshot();
});

test("zoom mouse", async ({ page }) => {
  await page.goto("http://localhost:5173");
  const canvas = await page.$("#canvas");
  expect(canvas).not.toBeNull();

  await page.keyboard.down("ControlOrMeta");
  await page.mouse.wheel(0, -1000);
  await page.keyboard.up("ControlOrMeta");

  const screenshot = await page.screenshot();
  expect(screenshot).toMatchSnapshot();
});

test("cut", async ({ page }) => {
  await page.goto("http://localhost:5173");
  const canvas = await page.$("#canvas");
  expect(canvas).not.toBeNull();

  let state: WaveShaperState = await page.evaluate(() => {
    const waveShaper = (globalThis as any)["WaveShaper"];
    return waveShaper.getState();
  });

  expect(state.intervals.length).toBe(2);

  await page.keyboard.down("ControlOrMeta");
  await canvas!.click({ button: "left", position: { x: 100, y: 50 } });
  await page.keyboard.up("ControlOrMeta");

  state = await page.evaluate(() => {
    const waveShaper = (globalThis as any)["WaveShaper"];
    return waveShaper.getState();
  });

  expect(state.intervals.length).toBe(3);

  const screenshot = await page.screenshot();
  expect(screenshot).toMatchSnapshot();
});
