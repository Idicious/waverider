/**
 * Number of samples inspected per pixel. The sample range behind a pixel is
 * decimated down to (at most) this many samples, which bounds the cost of
 * summarizing by the width of the draw area instead of the length of the audio.
 */
const RESOLUTION = 128;

/**
 * Two values per pixel - the negative and positive RMS of the samples behind
 * that pixel - packed as [min0, max0, min1, max1, ...].
 *
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

const cache = new Map<string, CacheData>();

/**
 * Summarize the audio behind a time window into one min/max pair per pixel.
 *
 * Pixels are placed on a grid anchored at sample 0, so the samples behind a
 * pixel depend only on its absolute grid index. That makes the summary stable
 * under panning, cutting and zooming: a pixel that is still on screen after a
 * pan describes exactly the same samples, so it can be moved into its new
 * position rather than recomputed.
 *
 * @param spp samples per pixel, i.e. the current zoom level
 */
export function summarizeAudio(
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

  const { drawData, gaps } = reuseCachedData(
    cacheKey,
    startPixel,
    width,
    spp,
    sampleRate
  );

  for (const [from, to] of gaps) {
    summarizeRange(data, drawData, startPixel, from, to, spp);
  }

  cache.set(cacheKey, { startPixel, width, spp, sampleRate, drawData });

  return drawData;
}

/**
 * Drop the summary held for a key. Call this when the thing being summarized
 * goes away, otherwise the cache grows for the lifetime of the page.
 */
export function clearCachedData(cacheKey: string) {
  cache.delete(cacheKey);
}

/**
 * Position the pixels we already have for this key, and report which ranges
 * still need to be computed.
 */
function reuseCachedData(
  cacheKey: string,
  startPixel: number,
  width: number,
  spp: number,
  sampleRate: number
): { drawData: DrawData; gaps: Array<[number, number]> } {
  const size = width * 2;
  const cached = cache.get(cacheKey);

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
    drawData.copyWithin(target * 2, source * 2, (source + overlap) * 2);
  } else {
    drawData = new Float32Array(size);
    drawData.set(
      cached!.drawData.subarray(source * 2, (source + overlap) * 2),
      target * 2
    );
  }

  const gaps: Array<[number, number]> = [];
  if (target > 0) gaps.push([0, target]);
  if (target + overlap < width) gaps.push([target + overlap, width]);

  return { drawData, gaps };
}

/**
 * Compute pixels [from, to) of the window starting at `startPixel`.
 *
 * Each pixel gets the RMS of its positive samples and the RMS of its negative
 * samples, so the waveform keeps a sense of its envelope on both sides of the
 * centre line. Only every `skip`th sample is inspected.
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

    let posSum = 0;
    let negSum = 0;
    let count = 0;

    for (let i = start; i < end; i += skip, count++) {
      const val = data[i];
      if (val > 0) {
        posSum += val * val;
      } else {
        negSum += val * val;
      }
    }

    const scale = count > 0 ? 1 / count : 0;

    drawData[pixel * 2] = -Math.sqrt(negSum * scale);
    drawData[pixel * 2 + 1] = Math.sqrt(posSum * scale);
  }
}
