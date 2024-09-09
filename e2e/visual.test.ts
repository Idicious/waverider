import { expect, test } from "@playwright/test";
import {
  expectScreenshot,
  getScales,
  loadPage,
  drag,
  zoom,
  getState,
  cutInterval,
  pan,
} from "./utils";

test("basic", async ({ page }) => {
  await loadPage(page);
  await expectScreenshot(page);
});

test("drag", async ({ page }) => {
  await loadPage(page);
  const { xScale } = await getScales(page);

  await drag(
    page,
    { track: "1", time: xScale.invert(5) },
    { track: "1", time: xScale.invert(100) }
  );

  await expectScreenshot(page);
});

test("drag to other track", async ({ page }) => {
  await loadPage(page);
  const { xScale } = await getScales(page);

  await drag(
    page,
    { track: "1", time: xScale.invert(5) },
    { track: "2", time: xScale.invert(200) }
  );

  await expectScreenshot(page);
});

test("pan", async ({ page }) => {
  await loadPage(page);
  const { xScale } = await getScales(page);

  await pan(
    page,
    { track: "1", time: xScale.invert(150) },
    { track: "1", time: xScale.invert(100) }
  );

  await expectScreenshot(page);
});

test("zoom mouse", async ({ page }) => {
  await loadPage(page);
  await zoom(page, { time: 0, track: "1" }, -1000);
  await expectScreenshot(page);
});

test("cut", async ({ page }) => {
  await loadPage(page);
  const { xScale } = await getScales(page);

  let state = await getState(page);

  expect(state.intervals.length).toBe(2);
  await cutInterval(page, state.intervals[0], xScale.invert(100));

  state = await getState(page);

  expect(state.intervals.length).toBe(3);
  await expectScreenshot(page);
});
