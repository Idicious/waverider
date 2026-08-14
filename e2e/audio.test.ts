import { expect, test } from "@playwright/test";
import {
  AUDIO_MODULE_URL,
  cutInterval,
  drag,
  getScales,
  getState,
  loadPage,
  pan,
  zoom,
} from "./utils";

/**
 * These drive the summarizer inside the browser and compare what the cache
 * hands back against a reference computed under a cold cache. Any pixel the
 * cache carries between calls has to match a full recompute exactly.
 */

const SAMPLE_RATE = 44100;

test.describe("summarizeAudio", () => {
  test.beforeEach(async ({ page }) => {
    await loadPage(page);
  });

  test("reuses cached pixels without drifting away from the audio", async ({
    page,
  }) => {
    // Panning by less than a pixel used to shift the cached pixels by a
    // rounded number of pixels and drop the remainder, so the waveform slowly
    // detached from the audio underneath it.
    const worst = await page.evaluate(
      async ({ url, sampleRate, spp }) => {
        const { AudioSummaryCache } = await import(url);
        const cache = new AudioSummaryCache();
        const summarizeAudio = cache.summarize.bind(cache);

        const data = new Float32Array(sampleRate * 10);
        for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 50) * 0.8;

        let refKey = 0;
        let worst = 0;

        for (const step of [0.5, 3, 5, 7, 11.6, 30]) {
          let start = 1000;
          summarizeAudio(data, "pan" + step, start, 2000, spp, sampleRate);

          for (let frame = 0; frame < 120; frame++) {
            start += step;

            const cached = summarizeAudio(
              data, "pan" + step, start, 2000, spp, sampleRate
            );
            const fresh = summarizeAudio(
              data, "cold" + refKey++, start, 2000, spp, sampleRate
            );

            if (cached.length !== fresh.length) return Number.NaN;
            for (let i = 0; i < cached.length; i++) {
              worst = Math.max(worst, Math.abs(cached[i] - fresh[i]));
            }
          }
        }

        return worst;
      },
      { url: AUDIO_MODULE_URL, sampleRate: SAMPLE_RATE, spp: 512 }
    );

    expect(worst).toBe(0);
  });

  test("reuses cached pixels when either edge is resized", async ({ page }) => {
    const worst = await page.evaluate(
      async ({ url, sampleRate, spp }) => {
        const { AudioSummaryCache } = await import(url);
        const cache = new AudioSummaryCache();
        const summarizeAudio = cache.summarize.bind(cache);

        const data = new Float32Array(sampleRate * 10);
        for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 37) * 0.7;

        const windows = [
          [1000, 2000], [1000, 2500], [1000, 1800], [900, 2600],
          [1200, 900], [1200, 3000], [800, 3400], [1000, 2000],
        ];

        let refKey = 0;
        let worst = 0;

        for (const [start, duration] of windows) {
          const cached = summarizeAudio(
            data, "resize", start, duration, spp, sampleRate
          );
          const fresh = summarizeAudio(
            data, "cold" + refKey++, start, duration, spp, sampleRate
          );

          if (cached.length !== fresh.length) return Number.NaN;
          for (let i = 0; i < cached.length; i++) {
            worst = Math.max(worst, Math.abs(cached[i] - fresh[i]));
          }
        }

        return worst;
      },
      { url: AUDIO_MODULE_URL, sampleRate: SAMPLE_RATE, spp: 512 }
    );

    expect(worst).toBe(0);
  });

  test("discards the cache when the zoom level changes", async ({ page }) => {
    // The cache was keyed on the d3 zoom factor, which the programmatic zoom()
    // entry point never touches - so a resolution change reused pixels that
    // were computed for a different samples-per-pixel.
    const result = await page.evaluate(
      async ({ url, sampleRate }) => {
        const { AudioSummaryCache } = await import(url);
        const cache = new AudioSummaryCache();
        const summarizeAudio = cache.summarize.bind(cache);

        const data = new Float32Array(sampleRate * 10);
        for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 50) * 0.8;

        summarizeAudio(data, "zoomed", 1000, 2000, 512, sampleRate);
        const cached = summarizeAudio(data, "zoomed", 1000, 2000, 256, sampleRate);
        const fresh = summarizeAudio(data, "cold", 1000, 2000, 256, sampleRate);

        let worst = 0;
        for (let i = 0; i < Math.min(cached.length, fresh.length); i++) {
          worst = Math.max(worst, Math.abs(cached[i] - fresh[i]));
        }

        return {
          cachedLength: cached.length,
          freshLength: fresh.length,
          worst,
        };
      },
      { url: AUDIO_MODULE_URL, sampleRate: SAMPLE_RATE }
    );

    expect(result.cachedLength).toBe(result.freshLength);
    expect(result.worst).toBe(0);
  });

  test("places the waveform using the audio's sample rate", async ({ page }) => {
    // 44.1kHz was hardcoded while the rest of the library reads
    // AudioContext.sampleRate, which is 48kHz on most hardware.
    const result = await page.evaluate(
      async ({ url }) => {
        const { AudioSummaryCache } = await import(url);
        const cache = new AudioSummaryCache();
        const summarizeAudio = cache.summarize.bind(cache);
        const { DRAW_STRIDE } = await import(url);

        const measure = (sampleRate: number) => {
          const data = new Float32Array(sampleRate * 2);
          for (
            let i = Math.round(0.5 * sampleRate);
            i < Math.round(0.6 * sampleRate);
            i++
          ) {
            data[i] = 0.9;
          }

          // 10ms per pixel, so the burst belongs in pixels 50..59
          const spp = sampleRate / 100;
          const summary = summarizeAudio(
            data, "sr" + sampleRate, 0, 1000, spp, sampleRate
          );

          let first = -1;
          let last = -1;
          for (let pixel = 0; pixel < summary.length / DRAW_STRIDE; pixel++) {
            if (summary[pixel * DRAW_STRIDE + 1] > 0.5) {
              if (first < 0) first = pixel;
              last = pixel;
            }
          }

          return { first, last, width: summary.length / DRAW_STRIDE };
        };

        return { at44100: measure(44100), at48000: measure(48000) };
      },
      { url: AUDIO_MODULE_URL }
    );

    expect(result.at44100).toEqual({ first: 50, last: 59, width: 100 });
    expect(result.at48000).toEqual({ first: 50, last: 59, width: 100 });
  });

  test("keeps full amplitude in the pixel that ends the buffer", async ({
    page,
  }) => {
    // Samples past the end of the buffer counted towards the average, fading
    // out the last pixel of every clip.
    const pixels = await page.evaluate(
      async ({ url, sampleRate }) => {
        const { AudioSummaryCache } = await import(url);
        const cache = new AudioSummaryCache();
        const summarizeAudio = cache.summarize.bind(cache);
        const { DRAW_STRIDE } = await import(url);

        const data = new Float32Array(sampleRate).fill(0.5); // exactly 1000ms
        // window runs 200ms past the end of the audio
        const summary = summarizeAudio(data, "tail", 800, 400, 512, sampleRate);

        const max: number[] = [];
        for (let pixel = 0; pixel < summary.length / DRAW_STRIDE; pixel++) {
          max.push(summary[pixel * DRAW_STRIDE + 1]);
        }
        return max;
      },
      { url: AUDIO_MODULE_URL, sampleRate: SAMPLE_RATE }
    );

    const inside = pixels.filter((v) => v > 0);
    const outside = pixels.filter((v) => v === 0);

    expect(inside.length).toBeGreaterThan(0);
    expect(outside.length).toBeGreaterThan(0);
    // every pixel backed by audio reads the true amplitude, none are dimmed
    for (const value of inside) expect(value).toBeCloseTo(0.5, 5);
  });

  test("reads the outline from peaks and the band from level", async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ({ url, sampleRate }) => {
        const { AudioSummaryCache } = await import(url);
        const cache = new AudioSummaryCache();
        const summarizeAudio = cache.summarize.bind(cache);
        const { DRAW_STRIDE } = await import(url);

        // a quiet tone with a short loud transient in every pixel
        const spp = 441;
        const data = new Float32Array(sampleRate);
        for (let i = 0; i < data.length; i++) {
          data[i] = i % spp < 30 ? 0.95 : 0.1 * Math.sin(i / 20);
        }

        const summary = summarizeAudio(data, "peaks", 200, 500, spp, sampleRate);
        const offset = 10 * DRAW_STRIDE;

        return {
          maxPeak: summary[offset + 1],
          maxBand: summary[offset + 3],
        };
      },
      { url: AUDIO_MODULE_URL, sampleRate: SAMPLE_RATE }
    );

    // the transient reaches the outline, but barely moves the level
    expect(result.maxPeak).toBeGreaterThan(0.9);
    expect(result.maxBand).toBeLessThan(0.4);
  });

  test("outlines the same signal the same way regardless of sign balance", async ({
    page,
  }) => {
    // the old sign-split RMS divided each side by the total sample count, so
    // the height of each half tracked how often the signal was positive
    const result = await page.evaluate(
      async ({ url, sampleRate }) => {
        const { AudioSummaryCache } = await import(url);
        const cache = new AudioSummaryCache();
        const summarizeAudio = cache.summarize.bind(cache);
        const { DRAW_STRIDE } = await import(url);

        const measure = (label: string, positive: (i: number) => boolean) => {
          const data = new Float32Array(sampleRate);
          for (let i = 0; i < data.length; i++) data[i] = positive(i) ? 1 : -1;

          const summary = summarizeAudio(data, label, 200, 500, 441, sampleRate);
          const offset = 10 * DRAW_STRIDE;

          return [summary[offset], summary[offset + 1]];
        };

        return {
          mostlyPositive: measure("dutyHigh", (i) => i % 10 !== 0),
          mostlyNegative: measure("dutyLow", (i) => i % 10 === 0),
        };
      },
      { url: AUDIO_MODULE_URL, sampleRate: SAMPLE_RATE }
    );

    expect(result.mostlyPositive).toEqual([-1, 1]);
    expect(result.mostlyNegative).toEqual([-1, 1]);
  });

  test("keeps the rms band inside the peak outline", async ({ page }) => {
    const violations = await page.evaluate(
      async ({ url, sampleRate }) => {
        const { AudioSummaryCache } = await import(url);
        const cache = new AudioSummaryCache();
        const summarizeAudio = cache.summarize.bind(cache);
        const { DRAW_STRIDE } = await import(url);

        let violations = 0;

        // lopsided, DC offset and one sided shapes at assorted zoom levels
        for (let shape = 0; shape < 60; shape++) {
          const data = new Float32Array(sampleRate);
          for (let i = 0; i < data.length; i++) {
            data[i] =
              (shape % 3 === 0 ? 0.6 : 0) +
              Math.sin(i / (3 + (shape % 17))) * (shape % 5) * 0.2;
          }

          const summary = summarizeAudio(
            data, "shape" + shape, 100 + shape, 400, 200 + shape, sampleRate
          );

          for (let pixel = 0; pixel < summary.length / DRAW_STRIDE; pixel++) {
            const o = pixel * DRAW_STRIDE;
            const [min, max, minRms, maxRms] = [
              summary[o], summary[o + 1], summary[o + 2], summary[o + 3],
            ];

            if (minRms < min || maxRms > max) violations++;
            if (min > 0 || max < 0) violations++;
            if (Number.isNaN(min) || Number.isNaN(maxRms)) violations++;
          }
        }

        return violations;
      },
      { url: AUDIO_MODULE_URL, sampleRate: SAMPLE_RATE }
    );

    expect(violations).toBe(0);
  });

  test("releases cached summaries when an interval is removed", async ({
    page,
  }) => {
    const worst = await page.evaluate(
      async ({ url, sampleRate }) => {
        const { AudioSummaryCache } = await import(url);
        const cache = new AudioSummaryCache();
        const summarizeAudio = cache.summarize.bind(cache);
        const clearCachedData = cache.clear.bind(cache);

        const data = new Float32Array(sampleRate * 2);
        for (let i = 0; i < data.length; i++) data[i] = Math.sin(i / 50) * 0.8;

        summarizeAudio(data, "gone", 0, 500, 512, sampleRate);
        clearCachedData("gone");

        // a new interval reusing the id must not inherit the old summary
        const after = summarizeAudio(data, "gone", 700, 500, 512, sampleRate);
        const fresh = summarizeAudio(data, "cold", 700, 500, 512, sampleRate);

        let worst = 0;
        for (let i = 0; i < after.length; i++) {
          worst = Math.max(worst, Math.abs(after[i] - fresh[i]));
        }
        return worst;
      },
      { url: AUDIO_MODULE_URL, sampleRate: SAMPLE_RATE }
    );

    expect(worst).toBe(0);
  });

  test("returns nothing for degenerate windows instead of throwing", async ({
    page,
  }) => {
    const lengths = await page.evaluate(
      async ({ url, sampleRate }) => {
        const { AudioSummaryCache } = await import(url);
        const cache = new AudioSummaryCache();
        const summarizeAudio = cache.summarize.bind(cache);
        const data = new Float32Array(sampleRate);

        return [
          [0, 1000],
          [-5, 1000],
          [512, 0],
          [512, -100],
        ].map(
          ([spp, duration]) =>
            summarizeAudio(data, "degenerate", 0, duration, spp, sampleRate)
              .length
        );
      },
      { url: AUDIO_MODULE_URL, sampleRate: SAMPLE_RATE }
    );

    expect(lengths).toEqual([0, 0, 0, 0]);
  });

  test("keeps the outline solid below one sample per pixel", async ({
    page,
  }) => {
    // Rounding both edges of a pixel onto the same sample used to leave the
    // range empty, which read as silence and broke the waveform into a comb of
    // alternating peaks and centre line - every other pixel at spp 0.5.
    const rows = await page.evaluate(
      async ({ url, sampleRate }) => {
        const { AudioSummaryCache, DRAW_STRIDE } = await import(url);

        // never crosses zero, so any empty bucket is the summariser's doing
        // rather than a genuine zero crossing
        const data = new Float32Array(sampleRate);
        for (let i = 0; i < data.length; i++) {
          data[i] = 0.5 + Math.sin(i / 8) * 0.4;
        }

        return [2, 1, 0.9, 0.5, 0.25, 0.1].map((spp) => {
          const cache = new AudioSummaryCache();
          const out = cache.summarize(data, "s" + spp, 0, 20, spp, sampleRate);
          const buckets = out.length / DRAW_STRIDE;

          let flat = 0;
          for (let i = 0; i < buckets; i++) {
            if (out[i * DRAW_STRIDE] === 0 && out[i * DRAW_STRIDE + 1] === 0) {
              flat++;
            }
          }

          return { spp, buckets, flat };
        });
      },
      { url: AUDIO_MODULE_URL, sampleRate: SAMPLE_RATE }
    );

    for (const row of rows) {
      expect(row.buckets).toBeGreaterThan(0);
      expect({ spp: row.spp, flat: row.flat }).toEqual({
        spp: row.spp,
        flat: 0,
      });
    }
  });
});

test.describe("waveform rendering", () => {
  /** Counts the dark waveform pixels drawn on top of the interval fill. */
  function countWavePixels(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          data[i] < 40 &&
          data[i + 1] < 40 &&
          data[i + 2] < 40 &&
          data[i + 3] > 0
        ) {
          dark++;
        }
      }
      return dark;
    });
  }

  test("keeps drawing a waveform through drag, zoom and pan", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await loadPage(page);
    expect(await countWavePixels(page)).toBeGreaterThan(100);

    const { xScale } = await getScales(page);
    await drag(
      page,
      { track: "1", time: xScale.invert(5) },
      { track: "1", time: xScale.invert(120) }
    );
    expect(await countWavePixels(page)).toBeGreaterThan(100);

    await zoom(page, { time: 0, track: "1" }, -600);
    expect(await countWavePixels(page)).toBeGreaterThan(100);

    // scales have moved with the zoom, so re-read them before panning
    const zoomed = await getScales(page);
    await pan(
      page,
      { track: "1", time: zoomed.xScale.invert(150) },
      { track: "1", time: zoomed.xScale.invert(100) }
    );
    expect(await countWavePixels(page)).toBeGreaterThan(100);

    expect(errors).toEqual([]);
  });

  /**
   * Counts pixels of an exact colour. The peak outline is drawn at 45% alpha,
   * so over the red track it lands on rgb(140,0,0); with the band switched off
   * the outline is drawn solid and that colour should not appear at all.
   */
  function countColor(
    page: import("@playwright/test").Page,
    rgb: [number, number, number]
  ) {
    return page.evaluate(([r, g, b]) => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

      let found = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === r && data[i + 1] === g && data[i + 2] === b) found++;
      }
      return found;
    }, rgb);
  }

  test("showRmsBand toggles the second layer off", async ({ page }) => {
    await loadPage(page);

    const washedOn = await countColor(page, [140, 0, 0]);
    const solidOn = await countColor(page, [0, 0, 0]);

    expect(washedOn).toBeGreaterThan(100);
    expect(solidOn).toBeGreaterThan(100);

    await page.uncheck("#rms-band");

    // the outline is jagged, so a little of the wash colour survives as
    // antialiasing along its edge - what matters is that the body of it goes
    await page.waitForFunction(
      (ceiling) => {
        const canvas = document.querySelector("canvas") as HTMLCanvasElement;
        const { data } = canvas
          .getContext("2d")!
          .getImageData(0, 0, canvas.width, canvas.height);

        let washed = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === 140 && data[i + 1] === 0 && data[i + 2] === 0) {
            washed++;
          }
        }
        return washed < ceiling;
      },
      washedOn / 10
    );

    // the outline is now drawn solid, so it covers what the wash used to
    expect(await countColor(page, [0, 0, 0])).toBeGreaterThan(solidOn);
  });

  test("keeps a transient's peak height fixed across zoom levels", async ({
    page,
  }) => {
    // The outline used to be filled as a polygon interpolated between
    // neighbouring buckets, so a transient alone in its bucket rendered as a
    // sliver whose antialiased tip faded by an amount that depended on the
    // buckets next to it - and those change with every zoom level. The same
    // peak must read as the same height no matter the zoom.
    await loadPage(page);

    const { heights, bandwidth } = await page.evaluate(async () => {
      const ws = (globalThis as any)["WaveShaper"];

      // One full-scale sample in two seconds of silence. The exact sample
      // rate does not matter: the spike is found by scanning, not predicted.
      const data = new Float32Array(96000);
      data[48000] = 0.9;

      ws.updateState((state: any) => {
        state.audioData = [{ id: "spike", data }];
        state.intervals = [
          {
            id: "spike-interval",
            start: 0,
            offsetStart: 0,
            end: 2000,
            index: 1,
            track: "1",
            data: "spike",
            fadeIn: 0,
            fadeOut: 0,
          },
        ];
        state.configuration.showAutomation = false;
        state.configuration.showRmsBand = false;
        return [state, undefined, undefined];
      });
      ws.process();

      const measure = () => {
        const scales = ws.getScaleData();
        const [d0, d1] = scales.x.domain;
        const [r0, r1] = scales.x.range;
        const toX = (t: number) => ((t - d0) / (d1 - d0)) * (r1 - r0) + r0;

        // The resize handles at the interval's edges are solid black and
        // full height, so the scan stays away from them and measures only
        // the wave bars.
        const lo = Math.ceil(toX(0)) + 10;
        const hi = Math.floor(toX(2000)) - 10;

        const canvas = document.querySelector("canvas") as HTMLCanvasElement;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        const { data: px, width } = ctx.getImageData(
          0,
          0,
          canvas.width,
          canvas.height
        );

        let tallest = 0;
        for (let x = Math.max(0, lo); x <= Math.min(width - 1, hi); x++) {
          let first = -1;
          let last = -1;
          for (let y = 0; y < canvas.height; y++) {
            const i = (y * width + x) * 4;
            const dark =
              px[i + 3] > 200 && px[i] + px[i + 1] + px[i + 2] < 150;
            if (dark) {
              if (first < 0) first = y;
              last = y;
            }
          }
          if (first >= 0) tallest = Math.max(tallest, last - first + 1);
        }
        return tallest;
      };

      const heights: number[] = [];
      for (const spp of [300, 441, 640, 900, 1323, 1900]) {
        ws.zoom(spp, 0);
        ws.process();
        heights.push(measure());
      }

      const scales = ws.getScaleData();
      const [y0, y1] = scales.y.range;
      const tracks = scales.y.domain.length;
      const bandwidth = ((y1 - y0) / tracks) * (1 - scales.y.padding);

      return { heights, bandwidth };
    });

    // every zoom level must actually show the spike...
    for (const height of heights) {
      expect(height).toBeGreaterThan(bandwidth * 0.35);
    }

    // ...at exactly the same height
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  });

  test("showWaveform off skips waveform work entirely", async ({ page }) => {
    await loadPage(page);
    const withWave = await countWavePixels(page);
    expect(withWave).toBeGreaterThan(100);

    await page.evaluate(() => {
      const ws = (globalThis as any)["WaveShaper"];
      ws.updateState((state: any) => {
        state.configuration.showWaveform = false;
        return [state, undefined, undefined];
      });
      ws.process();
    });

    // the waveform bodies go; the resize handles and automation lines are
    // dark too and legitimately stay, so this is a drop, not a zero
    expect(await countWavePixels(page)).toBeLessThan(withWave / 2);

    // and no summaries are computed or held for hidden waveforms
    const buckets = await page.evaluate(
      () => (globalThis as any)["WaveShaper"].getDiagnostics().waveformBuckets
    );
    expect(buckets).toBe(0);

    // toggling back on restores the identical rendering
    await page.evaluate(() => {
      const ws = (globalThis as any)["WaveShaper"];
      ws.updateState((state: any) => {
        state.configuration.showWaveform = true;
        return [state, undefined, undefined];
      });
      ws.process();
    });

    expect(await countWavePixels(page)).toBe(withWave);
  });

  test("keeps drawing a waveform after a cut", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await loadPage(page);
    const { xScale } = await getScales(page);
    const state = await getState(page);

    await cutInterval(page, state.intervals[0], xScale.invert(100));

    expect((await getState(page)).intervals.length).toBe(3);
    expect(await countWavePixels(page)).toBeGreaterThan(100);
    expect(errors).toEqual([]);
  });
});
