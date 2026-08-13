/**
 * Samples behind one bucket at the finest pyramid level. Below this size a
 * range is scanned from the raw samples, so the constant trades pyramid
 * memory against the length of the raw scan at a pixel's edges.
 */
const BASE_BUCKET = 64;

/**
 * Values per bucket at every pyramid level: min, max, sum of squares. The sum
 * is kept instead of an RMS because sums fold exactly when two buckets merge
 * into their parent; an RMS would need the counts carried alongside it.
 */
const LEVEL_STRIDE = 3;

/**
 * Pixels spanning at least this many samples are eligible for edge snapping
 * while a zoom gesture is in flight: edges land on the bucket grid, so folds
 * touch no raw samples at all. Snapping moves an edge by at most half a
 * bucket - a fraction of the pixel's own width at this span - but that is
 * still enough to bounce a transient between two neighbouring pixels as the
 * boundary re-rounds under a changing zoom, which is why it is only ever
 * applied mid-gesture, where the image is in motion. At rest every pixel is
 * exact. Below the threshold the unsnapped edges are cheap to scan anyway.
 */
const SNAP_THRESHOLD = BASE_BUCKET * 4;

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
  /**
   * Whether these pixels were computed with snapped edges. A summary is
   * homogeneous - extending it keeps the quality it was started with - so
   * exact and snapped pixels never sit next to each other in one array.
   */
  snapped: boolean;
  drawData: DrawData;
}

const EMPTY: DrawData = new Float32Array(0);

/**
 * Multi-resolution summary of one audio buffer.
 *
 * Level k folds the buffer into buckets of BASE_BUCKET << k samples, each
 * holding the true min, max and sum of squares of every sample behind it -
 * nothing is decimated, so a one-sample transient survives to the coarsest
 * level. Summarizing a pixel becomes folding the few buckets behind it
 * instead of scanning its samples, which makes the cost of a pixel
 * logarithmic in the zoom level rather than linear.
 *
 * Levels are Float64Array because the sums of squares grow with the bucket
 * size; at the coarsest level they cover the whole track, which is past the
 * point where accumulating in single precision visibly distorts the RMS.
 */
class AudioPyramid {
  readonly levels: Float64Array[] = [];

  constructor(data: Float32Array) {
    if (data.length === 0) return;

    const baseCount = Math.ceil(data.length / BASE_BUCKET);
    const base = new Float64Array(baseCount * LEVEL_STRIDE);

    for (let bucket = 0; bucket < baseCount; bucket++) {
      const start = bucket * BASE_BUCKET;
      const end = Math.min(start + BASE_BUCKET, data.length);

      let min = Infinity;
      let max = -Infinity;
      let sumSquares = 0;

      for (let i = start; i < end; i++) {
        const val = data[i];
        // Math.min/max compile to branchless float instructions; comparing
        // and assigning branches instead, and audio crosses a running
        // min/max unpredictably enough that those branches miss constantly.
        min = Math.min(min, val);
        max = Math.max(max, val);
        sumSquares += val * val;
      }

      const offset = bucket * LEVEL_STRIDE;
      base[offset] = min;
      base[offset + 1] = max;
      base[offset + 2] = sumSquares;
    }

    this.levels.push(base);

    let previous = base;
    while (previous.length / LEVEL_STRIDE > 1) {
      const count = Math.ceil(previous.length / LEVEL_STRIDE / 2);
      const next = new Float64Array(count * LEVEL_STRIDE);

      for (let bucket = 0; bucket < count; bucket++) {
        const left = bucket * 2 * LEVEL_STRIDE;
        const right = left + LEVEL_STRIDE;
        const offset = bucket * LEVEL_STRIDE;

        if (right < previous.length) {
          next[offset] = Math.min(previous[left], previous[right]);
          next[offset + 1] = Math.max(previous[left + 1], previous[right + 1]);
          next[offset + 2] = previous[left + 2] + previous[right + 2];
        } else {
          // Odd tail: the parent covers only its left child's samples. It is
          // only ever read for ranges that end inside the data, so the
          // missing right half can never be asked for.
          next[offset] = previous[left];
          next[offset + 1] = previous[left + 1];
          next[offset + 2] = previous[left + 2];
        }
      }

      this.levels.push(next);
      previous = next;
    }
  }
}

/** Running fold of a sample range; reused across pixels to avoid allocation. */
type Fold = {
  min: number;
  max: number;
  sumSquares: number;
};

/**
 * A pyramid is a pure function of its buffer, so unlike the pixel cache it is
 * safe to share across WaveShapers - and keyed weakly on the buffer, it goes
 * away with the audio without anyone having to say so.
 */
const PYRAMIDS = new WeakMap<Float32Array, AudioPyramid>();

/**
 * Holds the per-key summaries for one WaveShaper.
 *
 * This is an instance rather than a module global because keys are interval
 * ids: two WaveShapers on a page draw different audio under the same ids, and
 * sharing one cache between them hands each the other's pixels.
 */
export class AudioSummaryCache {
  #cache = new Map<string, CacheData>();

  /** Cumulative work counters, surfaced through diagnostics(). */
  #stats = { sampleReads: 0, bucketReads: 0, pyramidsBuilt: 0 };

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
   * @param snap allow snapped edges for a full recompute, for calls made
   *   while a zoom gesture is still moving. Never downgrades: extending an
   *   exact summary stays exact, and the settling call with snap unset
   *   discards a snapped summary wholesale.
   */
  summarize(
    data: Float32Array,
    cacheKey: string,
    startMs: number,
    durationMs: number,
    spp: number,
    sampleRate: number,
    snap = false
  ): DrawData {
    if (spp <= 0 || durationMs <= 0 || sampleRate <= 0) return EMPTY;

    const samplesPerMs = sampleRate / 1000;
    const startPixel = Math.round((startMs * samplesPerMs) / spp);
    const width = Math.round((durationMs * samplesPerMs) / spp);

    if (width <= 0) return EMPTY;

    const { drawData, gaps, snapped } = this.#reuseCachedData(
      cacheKey,
      startPixel,
      width,
      spp,
      sampleRate,
      snap
    );

    if (gaps.length > 0) {
      const pyramid = this.#getPyramid(data);

      for (const [from, to] of gaps) {
        summarizeRange(
          data,
          pyramid,
          drawData,
          startPixel,
          from,
          to,
          spp,
          snapped,
          this.#stats
        );
      }
    }

    this.#cache.set(cacheKey, {
      startPixel,
      width,
      spp,
      sampleRate,
      snapped,
      drawData,
    });

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
   * Cumulative counts of the work done since construction. Reads are deltas:
   * sample the counters before and after an interaction to see what it cost.
   */
  diagnostics() {
    return {
      summarySampleReads: this.#stats.sampleReads,
      summaryBucketReads: this.#stats.bucketReads,
      pyramidsBuilt: this.#stats.pyramidsBuilt,
    };
  }

  #getPyramid(data: Float32Array) {
    let pyramid = PYRAMIDS.get(data);

    if (pyramid === undefined) {
      pyramid = new AudioPyramid(data);
      PYRAMIDS.set(data, pyramid);

      this.#stats.pyramidsBuilt++;
      this.#stats.sampleReads += data.length;
    }

    return pyramid;
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
    sampleRate: number,
    snap: boolean
  ): { drawData: DrawData; gaps: Array<[number, number]>; snapped: boolean } {
    const size = width * DRAW_STRIDE;
    const cached = this.#cache.get(cacheKey);

    // A change in zoom level or sample rate moves every pixel onto a different
    // grid, so nothing can be carried over. Snapped pixels are also thrown
    // away when the caller wants exact ones - that is the refinement pass at
    // the end of a zoom gesture.
    const reusable =
      cached !== undefined &&
      cached.spp === spp &&
      cached.sampleRate === sampleRate &&
      (snap || !cached.snapped);

    if (!reusable) {
      const snapped = snap && spp >= SNAP_THRESHOLD;
      return { drawData: new Float32Array(size), gaps: [[0, width]], snapped };
    }

    // Gap pixels extend the cached summary, so they keep its quality: mixing
    // exact and snapped pixels in one array would make neighbouring pixels
    // disagree about where their shared edge is.
    const snapped = cached!.snapped;

    // Overlap between the cached window and the requested one, in grid pixels.
    const from = Math.max(startPixel, cached!.startPixel);
    const to = Math.min(startPixel + width, cached!.startPixel + cached!.width);
    const overlap = to - from;

    if (overlap <= 0) {
      return { drawData: new Float32Array(size), gaps: [[0, width]], snapped };
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

    return { drawData, gaps, snapped };
  }
}

/**
 * Compute pixels [from, to) of the window starting at `startPixel`.
 *
 * Each pixel gets the lowest and highest sample behind it plus the RMS of the
 * pixel as a whole, folded from the pyramid rather than scanned from the
 * samples. The fold is exact over every sample, so a transient shorter than a
 * pixel still registers no matter how far out the view is zoomed.
 */
function summarizeRange(
  data: Float32Array,
  pyramid: AudioPyramid,
  drawData: DrawData,
  startPixel: number,
  from: number,
  to: number,
  spp: number,
  snap: boolean,
  stats: { sampleReads: number; bucketReads: number }
) {
  const length = data.length;
  const fold: Fold = { min: 0, max: 0, sumSquares: 0 };

  for (let pixel = from; pixel < to; pixel++) {
    // Rounding both edges off the grid index keeps neighbouring pixels tiled
    // exactly, with no gap or overlap between their sample ranges: a pixel's
    // last edge and its neighbour's first are the same expression, so they
    // land on the same sample - snapped or not.
    let first = Math.round((startPixel + pixel) * spp);
    let last = Math.round((startPixel + pixel + 1) * spp);

    if (snap) {
      first = Math.round(first / BASE_BUCKET) * BASE_BUCKET;
      last = Math.round(last / BASE_BUCKET) * BASE_BUCKET;
    }

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
      foldRange(data, pyramid, start, end, fold, stats);

      min = Math.min(0, fold.min);
      max = Math.max(0, fold.max);
      rms = Math.sqrt(fold.sumSquares / (end - start));
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

      stats.sampleReads += 2;
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

/**
 * Fold samples [start, end) into `out`, taking the largest aligned pyramid
 * bucket available at each step and reading raw samples only for the
 * unaligned stubs at either edge. Those stubs are shorter than BASE_BUCKET
 * each, and the greedy walk doubles the bucket size while alignment allows
 * and halves it again toward the end of the range, so a fold touches
 * O(BASE_BUCKET + log(end - start)) values rather than every sample.
 *
 * A bucket is only ever taken when it fits inside [start, end), and end is
 * clamped to the data by the caller - so a bucket read here is always fully
 * backed by samples, which is what keeps the odd-tail parents built by
 * AudioPyramid out of reach.
 */
function foldRange(
  data: Float32Array,
  pyramid: AudioPyramid,
  start: number,
  end: number,
  out: Fold,
  stats: { sampleReads: number; bucketReads: number }
) {
  let min = Infinity;
  let max = -Infinity;
  let sumSquares = 0;

  let i = start;
  const alignedStart = Math.min(
    end,
    Math.ceil(start / BASE_BUCKET) * BASE_BUCKET
  );

  // Both raw loops fold with Math.min/max rather than compare-and-assign:
  // the branches mispredict on real audio and were most of this function's
  // profile, while the branchless forms cost the same cycle every sample.
  for (; i < alignedStart; i++) {
    const val = data[i];
    min = Math.min(min, val);
    max = Math.max(max, val);
    sumSquares += val * val;
  }

  const levels = pyramid.levels;
  let buckets = 0;

  while (i + BASE_BUCKET <= end) {
    // The largest usable bucket at i is bounded by i's alignment (the
    // trailing zeros of its base-bucket position; position 0 is aligned to
    // everything) and by the room left before end. Both are single bit
    // operations, which matters because this runs for every bucket of every
    // pixel being summarized.
    const bucket = (i / BASE_BUCKET) | 0;
    const remaining = ((end - i) / BASE_BUCKET) | 0;

    const alignment = bucket === 0 ? 30 : 31 - Math.clz32(bucket & -bucket);
    const fit = 31 - Math.clz32(remaining);

    const level = Math.min(alignment, fit, levels.length - 1);
    const size = BASE_BUCKET << level;

    const offset = (i / size) * LEVEL_STRIDE;
    const values = levels[level];

    if (values[offset] < min) min = values[offset];
    if (values[offset + 1] > max) max = values[offset + 1];
    sumSquares += values[offset + 2];

    i += size;
    buckets++;
  }

  const tailStart = i;
  for (; i < end; i++) {
    const val = data[i];
    min = Math.min(min, val);
    max = Math.max(max, val);
    sumSquares += val * val;
  }

  stats.sampleReads += alignedStart - start + (end - tailStart);
  stats.bucketReads += buckets;

  out.min = min;
  out.max = max;
  out.sumSquares = sumSquares;
}
