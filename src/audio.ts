/**
 * Number of samples inspected per pixel. The sample range behind a pixel is
 * decimated down to (at most) this many samples, which bounds the cost of
 * summarizing by the width of the draw area instead of the length of the audio.
 */
const RESOLUTION = 128;

/**
 * Values per pixel in a DrawData, in the order they are packed:
 *
 *   0 minPeak  lowest sample behind the pixel, or 0 if none go below it
 *   1 maxPeak  highest sample behind the pixel, or 0 if none go above it
 *   2 minRms   bottom of the RMS band
 *   3 maxRms   top of the RMS band
 *
 * The peaks give the outline of the waveform and the band, drawn inside it,
 * gives a sense of how much of that outline is actually carrying level. The
 * band is the RMS of the whole pixel mirrored about the centre line, clamped
 * into the peak envelope so a one sided signal cannot push it outside.
 */
export const DRAW_STRIDE = 4;

/**
 * A flat typed array keeps the summary allocation-free on the hot path; a
 * tuple per pixel meant thousands of short lived arrays on every frame.
 */
export type DrawData = Float32Array;

export interface CacheData {
  /**
   * Left edge of the summarized window, as an index into the global pixel
   * grid rather than a time. Everything is cached in grid coordinates so that
   * reusing pixels across a pan is an exact move instead of a rounded one.
   */
  startPixel: number;
  width: number;
  spp: number;
  sampleRate: number;
  drawData: DrawData;
}

const EMPTY: DrawData = new Float32Array(0);

/**
 * Holds the per-key summaries for one WaveShaper.
 *
 * This is an instance rather than a module global because keys are interval
 * ids: two WaveShapers on a page draw different audio under the same ids, and
 * sharing one cache between them hands each the other's pixels.
 */
export class AudioSummaryCache {
  #cache = new Map<string, CacheData>();

  /**
   * Summarize the audio behind a time window into one min/max pair per pixel.
   *
   * Pixels are placed on a grid anchored at sample 0, so the samples behind a
   * pixel depend only on its absolute grid index. That makes the summary
   * stable under panning, cutting and zooming: a pixel that is still on screen
   * after a pan describes exactly the same samples, so it can be moved into
   * its new position rather than recomputed.
   *
   * @param spp samples per pixel, i.e. the current zoom level
   */
  summarize(
    data: Float32Array,
    cacheKey: string,
    startMs: number,
    durationMs: number,
    spp: number,
    sampleRate: number
  ): DrawData {
    if (spp <= 0 || durationMs <= 0 || sampleRate <= 0) return EMPTY;

    const samplesPerMs = sampleRate / 1000;
    const startPixel = Math.round((startMs * samplesPerMs) / spp);
    const width = Math.round((durationMs * samplesPerMs) / spp);

    if (width <= 0) return EMPTY;

    const { drawData, gaps } = this.#reuseCachedData(
      cacheKey,
      startPixel,
      width,
      spp,
      sampleRate
    );

    for (const [from, to] of gaps) {
      summarizeRange(data, drawData, startPixel, from, to, spp);
    }

    this.#cache.set(cacheKey, { startPixel, width, spp, sampleRate, drawData });

    return drawData;
  }

  /**
   * Drop the summary held for a key. Call this when the thing being summarized
   * goes away, otherwise the cache grows for the lifetime of the page.
   */
  clear(cacheKey: string) {
    this.#cache.delete(cacheKey);
  }

  /** Drop every summary, for when the whole instance is being torn down. */
  clearAll() {
    this.#cache.clear();
  }

  /**
   * Position the pixels we already have for this key, and report which ranges
   * still need to be computed.
   */
  #reuseCachedData(
    cacheKey: string,
    startPixel: number,
    width: number,
    spp: number,
    sampleRate: number
  ): { drawData: DrawData; gaps: Array<[number, number]> } {
    const size = width * DRAW_STRIDE;
    const cached = this.#cache.get(cacheKey);

    // A change in zoom level or sample rate moves every pixel onto a different
    // grid, so nothing can be carried over.
    const reusable =
      cached !== undefined &&
      cached.spp === spp &&
      cached.sampleRate === sampleRate;

    if (!reusable) {
      return { drawData: new Float32Array(size), gaps: [[0, width]] };
    }

    // Overlap between the cached window and the requested one, in grid pixels.
    const from = Math.max(startPixel, cached!.startPixel);
    const to = Math.min(startPixel + width, cached!.startPixel + cached!.width);
    const overlap = to - from;

    if (overlap <= 0) {
      return { drawData: new Float32Array(size), gaps: [[0, width]] };
    }

    const source = from - cached!.startPixel;
    const target = from - startPixel;

    let drawData: DrawData;
    if (cached!.drawData.length === size) {
      // Same width: shift in place, which is the common case while panning.
      drawData = cached!.drawData;
      drawData.copyWithin(
        target * DRAW_STRIDE,
        source * DRAW_STRIDE,
        (source + overlap) * DRAW_STRIDE
      );
    } else {
      drawData = new Float32Array(size);
      drawData.set(
        cached!.drawData.subarray(
          source * DRAW_STRIDE,
          (source + overlap) * DRAW_STRIDE
        ),
        target * DRAW_STRIDE
      );
    }

    const gaps: Array<[number, number]> = [];
    if (target > 0) gaps.push([0, target]);
    if (target + overlap < width) gaps.push([target + overlap, width]);

    return { drawData, gaps };
  }
}

/**
 * Compute pixels [from, to) of the window starting at `startPixel`.
 *
 * Each pixel gets the lowest and highest sample behind it plus the RMS of the
 * pixel as a whole. Only every `skip`th sample is inspected, so a transient
 * shorter than the decimation step can still be missed when zoomed far out.
 */
function summarizeRange(
  data: Float32Array,
  drawData: DrawData,
  startPixel: number,
  from: number,
  to: number,
  spp: number
) {
  const skip = Math.max(1, Math.ceil(spp / RESOLUTION));
  const length = data.length;

  for (let pixel = from; pixel < to; pixel++) {
    // Rounding both edges off the grid index keeps neighbouring pixels tiled
    // exactly, with no gap or overlap between their sample ranges.
    const first = Math.round((startPixel + pixel) * spp);
    const last = Math.round((startPixel + pixel + 1) * spp);

    // Clamp to the buffer so a pixel that only partly covers the audio is
    // averaged over the samples that actually exist, instead of being faded
    // out by the ones that do not.
    const start = Math.max(first, 0);
    const end = Math.min(last, length);

    // Peaks are measured against the centre line rather than against the
    // samples, so a pixel that never crosses zero still reads as a block from
    // the centre out to its level instead of a detached sliver.
    let min = 0;
    let max = 0;
    let rms = 0;

    if (end > start) {
      let sumSquares = 0;
      let count = 0;

      for (let i = start; i < end; i += skip, count++) {
        const val = data[i];
        if (val < min) min = val;
        else if (val > max) max = val;

        sumSquares += val * val;
      }

      rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;
    } else if (start < length) {
      // Fewer than one sample per pixel. Rounding both edges onto the same
      // sample leaves the range empty, and reporting that as silence broke the
      // outline into a comb of alternating peaks and centre line. The pixel
      // sits between two samples, so read the signal there instead.
      const position = Math.max(0, (startPixel + pixel) * spp);
      const index = Math.min(Math.floor(position), length - 1);
      const next = Math.min(index + 1, length - 1);
      const t = Math.min(1, Math.max(0, position - index));

      const value = data[index] + (data[next] - data[index]) * t;

      min = Math.min(0, value);
      max = Math.max(0, value);
      rms = Math.abs(value);
    }

    const offset = pixel * DRAW_STRIDE;

    drawData[offset] = min;
    drawData[offset + 1] = max;
    // Keep the band inside the outline; RMS can exceed a peak on the quiet
    // side of a lopsided pixel.
    drawData[offset + 2] = Math.max(min, -rms);
    drawData[offset + 3] = Math.min(max, rms);
  }
}
