import { expect, test } from "@playwright/test";
import { cutInterval, getScales, getState, loadPage, zoom } from "./utils";

/**
 * Covers the things that only go wrong once a WaveShaper has been alive for a
 * while, or is embedded in something that outlives it: bindings that are never
 * handed back, listeners that survive teardown, and a canvas that is sized for
 * one device pixel ratio but drawn at another.
 */

/** Adds an interval, then removes it again, N times over. */
function churnIntervals(page: import("@playwright/test").Page, rounds: number) {
  return page.evaluate((count) => {
    const waveShaper = (globalThis as any)["WaveShaper"];

    for (let i = 0; i < count; i++) {
      const added = `churn-${i}`;

      waveShaper.updateState((state: any) => {
        const template = state.intervals[0];
        state.intervals.push({ ...template, id: added, index: 99 });
        return [state, undefined, undefined];
      });

      waveShaper.process();

      waveShaper.updateState((state: any) => {
        state.intervals = state.intervals.filter((i: any) => i.id !== added);
        return [state, undefined, undefined];
      });

      waveShaper.process();
    }

    return waveShaper.getDiagnostics().boundElements;
  }, rounds);
}

test("hands bind colors back when intervals go away", async ({ page }) => {
  await loadPage(page);

  const settled = await churnIntervals(page, 1);
  const afterChurn = await churnIntervals(page, 25);

  // Every added interval binds a body, two resize handles and two fade
  // handles. Without a release path this grew by five per round.
  expect(afterChurn).toBe(settled);
});

test("keeps hit testing working after the colors have been recycled", async ({
  page,
}) => {
  await loadPage(page);
  await churnIntervals(page, 25);

  const { xScale } = await getScales(page);
  let state = await getState(page);
  const before = state.intervals.length;

  await cutInterval(page, state.intervals[0], xScale.invert(100));

  state = await getState(page);
  expect(state.intervals.length).toBe(before + 1);
});

test("destroy detaches listeners and stops painting", async ({ page }) => {
  await loadPage(page);

  const before = (await getState(page)).intervals.length;

  const result = await page.evaluate(async () => {
    const waveShaper = (globalThis as any)["WaveShaper"];
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;

    const runningBefore = waveShaper.getDiagnostics().running;
    waveShaper.destroy();

    // a state change that would normally repaint on the next frame
    const painted = canvas.toDataURL();
    waveShaper.updateState((state: any) => {
      state.intervals[0].start += 500;
      return [state, undefined, undefined];
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    return {
      runningBefore,
      runningAfter: waveShaper.getDiagnostics().running,
      repainted: canvas.toDataURL() !== painted,
      boundElements: waveShaper.getDiagnostics().boundElements,
      // a second call must not throw
      idempotent: (() => {
        waveShaper.destroy();
        return true;
      })(),
    };
  });

  expect(result.runningBefore).toBe(true);
  expect(result.runningAfter).toBe(false);
  expect(result.repainted).toBe(false);
  expect(result.boundElements).toBe(0);
  expect(result.idempotent).toBe(true);

  // the click handler is gone, so this cannot cut any more
  const canvas = await page.$("canvas");
  await page.keyboard.down("Meta");
  await canvas!.click({ button: "left", position: { x: 200, y: 50 } });
  await page.keyboard.up("Meta");

  expect((await getState(page)).intervals.length).toBe(before);
});

test("resize keeps the left edge and the zoom level", async ({ page }) => {
  await loadPage(page);

  const before = (await getScales(page)).xScale.domain();

  const sizes = await page.evaluate(() => {
    const waveShaper = (globalThis as any)["WaveShaper"];
    waveShaper.resize(500, 300);

    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    return {
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      styleWidth: canvas.style.width,
      styleHeight: canvas.style.height,
      dpr: window.devicePixelRatio,
    };
  });

  expect(sizes.styleWidth).toBe("500px");
  expect(sizes.styleHeight).toBe("300px");
  expect(sizes.backingWidth).toBe(Math.round(500 * sizes.dpr));
  expect(sizes.backingHeight).toBe(Math.round(300 * sizes.dpr));

  const after = (await getScales(page)).xScale.domain();

  // half the width at the same ms per pixel means half the visible time,
  // measured from the same left edge
  expect(after[0]).toBeCloseTo(before[0], 6);
  expect(after[1] - after[0]).toBeCloseTo((before[1] - before[0]) / 2, 6);
});

test("programmatic zoom does not leave a stale transform behind", async ({
  page,
}) => {
  await loadPage(page);

  const domains = await page.evaluate(() => {
    const waveShaper = (globalThis as any)["WaveShaper"];

    waveShaper.zoom(500, 0);
    const first = waveShaper.getScaleData().x.domain;

    // the same call twice has to land in the same place; it did not while the
    // zoom behaviour still held the transform from the previous view
    waveShaper.zoom(500, 0);
    const second = waveShaper.getScaleData().x.domain;

    waveShaper.zoom(1000, 0);
    const zoomedOut = waveShaper.getScaleData().x.domain;

    return { first, second, zoomedOut };
  });

  expect(domains.second).toEqual(domains.first);
  // twice the samples per pixel is twice the visible time
  expect(domains.zoomedOut[1] - domains.zoomedOut[0]).toBeCloseTo(
    (domains.first[1] - domains.first[0]) * 2,
    -1
  );
});

test("one wheel notch zooms the same under either modifier", async ({
  page,
}) => {
  // d3's default wheelDelta multiplies by ten whenever ctrlKey is held, so
  // before WaveShaper supplied its own, a notch zoomed 2^20x on the platforms
  // that gate zoom with Ctrl against 2^4x on macOS. That is far enough past the
  // audio that the summary window degenerates and the waveform stops being
  // drawn, and it only showed up when the suite ran on a second platform.
  // Configuring the key here pins the invariant on whichever one is to hand.
  const spans: number[] = [];

  for (const key of ["meta", "ctrl"] as const) {
    await loadPage(page);

    // Reached directly: the modifier is read from configuration on every event
    // and there is no setter for it.
    await page.evaluate((k) => {
      (globalThis as any)["WaveShaper"].state.configuration.modifierKey = k;
    }, key);

    const before = (await getScales(page)).xScale.domain();
    await zoom(page, { time: 0, track: "1" }, -1000);
    const after = (await getScales(page)).xScale.domain();

    expect(after[1] - after[0]).toBeLessThan(before[1] - before[0]);
    spans.push(after[1] - after[0]);
  }

  expect(spans[1]).toBe(spans[0]);
});

/**
 * Widest on-screen interval in CSS pixels, alongside the reported diagnostics.
 * The waveform summary holds one bucket per device pixel, so the two should
 * differ by exactly the device pixel ratio.
 */
function measureWaveform(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const waveShaper = (globalThis as any)["WaveShaper"];
    const { x } = waveShaper.getScaleData();
    const [domainStart, domainEnd] = x.domain;
    const [rangeStart, rangeEnd] = x.range;
    const pxPerMs = (rangeEnd - rangeStart) / (domainEnd - domainStart);

    let widestCssWidth = 0;
    for (const interval of waveShaper.getState().intervals) {
      const start = Math.max(interval.start + interval.offsetStart, domainStart);
      const end = Math.min(interval.end, domainEnd);
      widestCssWidth = Math.max(widestCssWidth, (end - start) * pxPerMs);
    }

    return { ...waveShaper.getDiagnostics(), widestCssWidth };
  });
}

test("summarises one bucket per pixel at standard density", async ({
  page,
}) => {
  await loadPage(page);
  const m = await measureWaveform(page);

  expect(m.pixelRatio).toBe(1);
  expect(m.waveformBuckets).toBeGreaterThan(m.widestCssWidth * 0.95);
  expect(m.waveformBuckets).toBeLessThan(m.widestCssWidth * 1.05);
});

test.describe("on a high density display", () => {
  test.use({ deviceScaleFactor: 2 });

  test("summarises the waveform at device resolution", async ({ page }) => {
    await loadPage(page);
    const m = await measureWaveform(page);

    expect(m.pixelRatio).toBe(2);

    // Twice the buckets for the same CSS width. Summarising per CSS pixel
    // renders a 1x waveform crisply, which looks sharp but carries half the
    // detail the display can show.
    expect(m.waveformBuckets).toBeGreaterThan(m.widestCssWidth * 1.95);
    expect(m.waveformBuckets).toBeLessThan(m.widestCssWidth * 2.05);
  });

  test("draws at device resolution and still hit tests correctly", async ({
    page,
  }) => {
    await loadPage(page);

    const sizes = await page.evaluate(() => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      return {
        dpr: window.devicePixelRatio,
        backingWidth: canvas.width,
        styleWidth: canvas.style.width,
      };
    });

    expect(sizes.dpr).toBe(2);
    expect(sizes.styleWidth).toBe("1000px");
    expect(sizes.backingWidth).toBe(2000);

    // Hit testing reads the offscreen canvas, which is now drawn at 2x. If the
    // read is not scaled to match, this click lands on the wrong element and
    // no cut happens.
    const { xScale } = await getScales(page);
    let state = await getState(page);
    const before = state.intervals.length;

    await cutInterval(page, state.intervals[0], xScale.invert(100));

    state = await getState(page);
    expect(state.intervals.length).toBe(before + 1);
  });
});
