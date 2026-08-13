import { expect, test } from "@playwright/test";
import {
  drag,
  getModifier,
  getScales,
  getState,
  loadPage,
  pan,
} from "./utils";

/**
 * The canvas is no longer repainted wholesale: a filtered bind repaints only
 * the regions its renderer reported, and a pan shifts the pixels already on
 * screen and repaints only the exposed strip. Two properties keep that
 * honest, and both are pinned here:
 *
 * - whatever shortcuts were taken along the way, a settled canvas must be
 *   indistinguishable from one painted from scratch;
 * - the shortcuts must actually be taken, which the lastPaintFraction
 *   diagnostic makes observable.
 */

/** The canvas, as it is, against the same canvas fully repainted. */
async function expectSettledEqualsFullRepaint(
  page: import("@playwright/test").Page
) {
  const identical = await page.evaluate(() => {
    const ws = (globalThis as any)["WaveShaper"];
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    const settled = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    ws.invalidate();
    ws.process();

    const repainted = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    if (settled.length !== repainted.length) return false;
    for (let i = 0; i < settled.length; i++) {
      if (settled[i] !== repainted[i]) return false;
    }
    return true;
  });

  expect(identical).toBe(true);
}

test("a settled drag leaves exactly what a full repaint would", async ({
  page,
}) => {
  await loadPage(page);
  const { xScale } = await getScales(page);

  await drag(
    page,
    { track: "1", time: xScale.invert(5) },
    { track: "2", time: xScale.invert(400) }
  );

  await expectSettledEqualsFullRepaint(page);
});

test("a settled pan leaves exactly what a full repaint would", async ({
  page,
}) => {
  await loadPage(page);
  const { xScale } = await getScales(page);

  await pan(
    page,
    { track: "1", time: xScale.invert(600) },
    { track: "1", time: xScale.invert(113) }
  );
  // the gesture's end refine has to land before the comparison
  await page.waitForTimeout(150);

  await expectSettledEqualsFullRepaint(page);
});

test("dragging an interval repaints only its own region", async ({ page }) => {
  await loadPage(page);
  const { xScale } = await getScales(page);
  const state = await getState(page);
  const interval = state.intervals[0];

  await drag(
    page,
    { track: interval.track, time: xScale.invert(60) },
    { track: interval.track, time: xScale.invert(200) }
  );

  // the fraction of the final mid-drag paint: the interval plus its slop,
  // nowhere near the whole canvas
  const fraction = await page.evaluate(
    () => (globalThis as any)["WaveShaper"].getDiagnostics().lastPaintFraction
  );

  expect(fraction).toBeGreaterThan(0);
  expect(fraction).toBeLessThan(0.5);
});

test("panning repaints only the exposed strip", async ({ page }) => {
  await loadPage(page);

  const modifier = await getModifier(page);
  const box = (await (await page.$("canvas"))!.boundingBox())!;

  await page.keyboard.down(modifier);
  await page.mouse.move(box.x + 700, box.y + 100);
  await page.mouse.down();

  // read the fraction mid-gesture, after a small step, before mouseup: the
  // end refine is deliberately a full pass and would overwrite it
  await page.mouse.move(box.x + 680, box.y + 100, { steps: 1 });
  await page.waitForTimeout(100);

  const fraction = await page.evaluate(
    () => (globalThis as any)["WaveShaper"].getDiagnostics().lastPaintFraction
  );

  await page.mouse.up();
  await page.keyboard.up(modifier);

  expect(fraction).toBeGreaterThan(0);
  expect(fraction).toBeLessThan(0.1);
});

test("the gesture-end refine repaints everything", async ({ page }) => {
  await loadPage(page);
  const { xScale } = await getScales(page);

  await pan(
    page,
    { track: "1", time: xScale.invert(500) },
    { track: "1", time: xScale.invert(300) }
  );
  await page.waitForTimeout(150);

  const fraction = await page.evaluate(
    () => (globalThis as any)["WaveShaper"].getDiagnostics().lastPaintFraction
  );

  expect(fraction).toBe(1);
});

test("showPaintRegions tints exactly the repainted region", async ({
  page,
}) => {
  await loadPage(page);
  const { xScale } = await getScales(page);

  const countOverlay = () =>
    page.evaluate(() => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const { data, width } = ctx.getImageData(
        0,
        0,
        canvas.width,
        canvas.height
      );

      // the overlay border is filled opaque magenta so it reads back exactly
      let inLeftHalf = 0;
      let inRightThird = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 255) {
          const x = (i / 4) % width;
          if (x < width / 2) inLeftHalf++;
          if (x > (width * 2) / 3) inRightThird++;
        }
      }
      return { inLeftHalf, inRightThird };
    });

  await page.evaluate(() => {
    const ws = (globalThis as any)["WaveShaper"];
    ws.updateState((state: any) => {
      state.configuration.showPaintRegions = true;
      // confine the flash subject to the left half of the view
      state.intervals = state.intervals.filter((i: any) => i.id === "1");
      state.intervals[0].end = 5000;
      return [state, undefined, undefined];
    });
    ws.process();
  });

  // drag the clip within the left half: the tint must cover its region and
  // stay out of the untouched right third
  await drag(
    page,
    { track: "1", time: xScale.invert(100) },
    { track: "1", time: xScale.invert(160) }
  );

  const flashed = await countOverlay();
  expect(flashed.inLeftHalf).toBeGreaterThan(0);
  expect(flashed.inRightThird).toBe(0);

  // turning the flag off leaves no trace of the overlay
  await page.evaluate(() => {
    const ws = (globalThis as any)["WaveShaper"];
    ws.updateState((state: any) => {
      state.configuration.showPaintRegions = false;
      return [state, undefined, undefined];
    });
    ws.process();
  });

  const cleared = await countOverlay();
  expect(cleared.inLeftHalf).toBe(0);
  expect(cleared.inRightThird).toBe(0);
});
