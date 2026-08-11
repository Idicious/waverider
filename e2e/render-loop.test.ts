import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { getModifier, getScales, loadPage, pan } from "./utils";

/**
 * Nothing in the scene animates, so the loop should sit idle until something
 * changes and then paint once.
 */

/** Counts paints over a window of time, optionally while doing something. */
function countPaints(page: Page, ms: number) {
  return page.evaluate(async (duration) => {
    const ws = (globalThis as any)["WaveShaper"];
    const redraw = ws.redraw.bind(ws);
    const redrawHidden = ws.redrawHidden.bind(ws);

    let visible = 0;
    let hidden = 0;
    ws.redraw = () => { visible++; redraw(); };
    ws.redrawHidden = () => { hidden++; redrawHidden(); };

    await new Promise((resolve) => setTimeout(resolve, duration));

    delete ws.redraw;
    delete ws.redrawHidden;

    return { visible, hidden };
  }, ms);
}

test("sits idle when nothing changes", async ({ page }) => {
  await loadPage(page);

  const painted = await countPaints(page, 600);

  expect(painted.visible).toBe(0);
  expect(painted.hidden).toBe(0);
});

test("coalesces several changes in a frame into one paint", async ({ page }) => {
  await loadPage(page);

  const painted = await page.evaluate(async () => {
    const ws = (globalThis as any)["WaveShaper"];
    const redraw = ws.redraw.bind(ws);

    let visible = 0;
    ws.redraw = () => { visible++; redraw(); };

    ws.invalidate();
    ws.invalidate();
    ws.invalidate();

    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );

    delete ws.redraw;
    return visible;
  });

  expect(painted).toBe(1);
});

test("paints again when state changes", async ({ page }) => {
  await loadPage(page);

  const before = await page.evaluate(() =>
    (document.querySelector("canvas") as HTMLCanvasElement).toDataURL()
  );

  // the automation checkbox goes through updateState, the ordinary path
  await page.check("#automation");
  await page.waitForFunction(
    (previous) =>
      (document.querySelector("canvas") as HTMLCanvasElement).toDataURL() !==
      previous,
    before
  );

  // and then settles again
  expect((await countPaints(page, 400)).visible).toBe(0);
});

test("repaints on zoom and pan", async ({ page }) => {
  // mid-gesture repaints are carried by the bind emitted on every zoom tick;
  // the end handler only refines quality afterwards, so losing the per-tick
  // emit would freeze the view until the gesture finished
  await loadPage(page);

  const snapshot = () =>
    page.evaluate(() =>
      (document.querySelector("canvas") as HTMLCanvasElement).toDataURL()
    );

  const initial = await snapshot();

  // not the shared zoom helper: it feeds canvas relative coordinates to
  // page.mouse, which wants viewport ones, so the wheel misses the canvas
  const box = (await (await page.$("canvas"))!.boundingBox())!;
  const modifier = await getModifier(page);

  await page.mouse.move(box.x + 200, box.y + 100);
  await page.keyboard.down(modifier);
  await page.mouse.wheel(0, -600);
  await page.keyboard.up(modifier);

  await page.waitForFunction(
    (previous) =>
      (document.querySelector("canvas") as HTMLCanvasElement).toDataURL() !==
      previous,
    initial
  );

  const zoomed = await snapshot();
  const { xScale } = await getScales(page);

  await pan(
    page,
    { track: "1", time: xScale.invert(300) },
    { track: "1", time: xScale.invert(150) }
  );
  await page.waitForFunction(
    (previous) =>
      (document.querySelector("canvas") as HTMLCanvasElement).toDataURL() !==
      previous,
    zoomed
  );

  // The gesture's end event refines the waveform from approximate to exact
  // pixels, which is one more paint on its own frame; let it flush so the
  // quiet window below measures rest, not the tail of the gesture.
  await page.waitForTimeout(100);

  // and goes quiet again once the gesture is over
  expect((await countPaints(page, 400)).visible).toBe(0);
});

test("does not rebuild the hit canvas on every mouse move", async ({ page }) => {
  await loadPage(page);

  const painted = await page.evaluate(async () => {
    const ws = (globalThis as any)["WaveShaper"];
    const redrawHidden = ws.redrawHidden.bind(ws);

    let hidden = 0;
    ws.redrawHidden = () => { hidden++; redrawHidden(); };

    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();

    for (let i = 0; i < 40; i++) {
      canvas.dispatchEvent(
        new MouseEvent("mousemove", {
          clientX: box.left + 100 + i,
          clientY: box.top + 60,
          bubbles: true,
        })
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    delete ws.redrawHidden;
    return hidden;
  });

  // at most one rebuild for the whole sweep, not one per event
  expect(painted).toBeLessThanOrEqual(1);
});

test("keeps hit testing correct across edits", async ({ page }) => {
  await loadPage(page);

  const positions = await page.evaluate(async () => {
    const ws = (globalThis as any)["WaveShaper"];
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();

    const at = (x: number, y: number) =>
      ws.getTargetElement({ clientX: box.left + x, clientY: box.top + y });

    const state = ws.getState();
    const interval = state.intervals[0];

    // somewhere inside the first interval, clear of the resize handles
    const { x } = ws.getScaleData();
    const toPx = (ms: number) =>
      ((ms - x.domain[0]) / (x.domain[1] - x.domain[0])) *
        (x.range[1] - x.range[0]) +
      x.range[0];

    const probe = toPx(interval.start + interval.offsetStart) + 40;
    const found = at(probe, 60);

    // 30ms per pixel here, so move it far enough that the old probe point is
    // well clear of the interval, then confirm the hit canvas caught up
    // without anyone asking for a redraw
    const move = 6000;
    ws.updateState((s: any) => {
      const target = s.intervals.find((i: any) => i.id === interval.id);
      target.start += move;
      target.end += move;
      return [s, undefined, undefined];
    });

    const afterAtOldSpot = at(probe, 60);
    const afterAtNewSpot = at(
      toPx(interval.start + interval.offsetStart + move) + 40,
      60
    );

    return {
      hitBefore: found != null,
      hitOldSpot: afterAtOldSpot != null,
      hitNewSpot: afterAtNewSpot != null,
    };
  });

  expect(positions.hitBefore).toBe(true);
  expect(positions.hitOldSpot).toBe(false);
  expect(positions.hitNewSpot).toBe(true);
});
