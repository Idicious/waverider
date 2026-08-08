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
        const { summarizeAudio } = await import(url);

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
        const { summarizeAudio } = await import(url);

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
        const { summarizeAudio } = await import(url);

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
        const { summarizeAudio } = await import(url);

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
          for (let pixel = 0; pixel < summary.length / 2; pixel++) {
            if (summary[pixel * 2 + 1] > 0.5) {
              if (first < 0) first = pixel;
              last = pixel;
            }
          }

          return { first, last, width: summary.length / 2 };
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
        const { summarizeAudio } = await import(url);

        const data = new Float32Array(sampleRate).fill(0.5); // exactly 1000ms
        // window runs 200ms past the end of the audio
        const summary = summarizeAudio(data, "tail", 800, 400, 512, sampleRate);

        const max: number[] = [];
        for (let pixel = 0; pixel < summary.length / 2; pixel++) {
          max.push(summary[pixel * 2 + 1]);
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

  test("releases cached summaries when an interval is removed", async ({
    page,
  }) => {
    const worst = await page.evaluate(
      async ({ url, sampleRate }) => {
        const { summarizeAudio, clearCachedData } = await import(url);

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
        const { summarizeAudio } = await import(url);
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
