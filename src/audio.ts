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
 * Samples inspected per pixel by the approximate summarizer that fills in
 * while a pyramid is still building - the decimated scan this library used
 * for everything before pyramids existed.
 */
const FALLBACK_RESOLUTION = 128;

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
 * Build every pyramid level for one buffer.
 *
 * Deliberately self-contained - constants arrive as parameters and nothing
 * from module scope is referenced - because its own source text doubles as
 * the body of the build worker. A closure would stringify into code that
 * throws inside the worker, so keep it free-standing.
 */
function buildLevels(
  data: Float32Array,
  baseBucket: number,
  levelStride: number
): Float64Array[] {
  if (data.length === 0) return [];

  const levels: Float64Array[] = [];
  const baseCount = Math.ceil(data.length / baseBucket);
  const base = new Float64Array(baseCount * levelStride);

  for (let bucket = 0; bucket < baseCount; bucket++) {
    const start = bucket * baseBucket;
    const end = Math.min(start + baseBucket, data.length);

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

    const offset = bucket * levelStride;
    base[offset] = min;
    base[offset + 1] = max;
    base[offset + 2] = sumSquares;
  }

  levels.push(base);

  let previous = base;
  while (previous.length / levelStride > 1) {
    const count = Math.ceil(previous.length / levelStride / 2);
    const next = new Float64Array(count * levelStride);

    for (let bucket = 0; bucket < count; bucket++) {
      const left = bucket * 2 * levelStride;
      const right = left + levelStride;
      const offset = bucket * levelStride;

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

    levels.push(next);
    previous = next;
  }

  return levels;
}

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
  constructor(readonly levels: Float64Array[]) {}
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
 * away with the audio without anyone having to say so. An entry with a null
 * pyramid is one still being built; the waiters run when it lands.
 */
type PyramidEntry = {
  pyramid: AudioPyramid | null;
  waiters: Set<() => void>;
};

const PYRAMIDS = new WeakMap<Float32Array, PyramidEntry>();

/** Builds still in flight, module-wide; surfaced through diagnostics(). */
let pendingBuilds = 0;

/**
 * The build worker is created from the build function's own source text, so
 * there is no separate worker file for a bundler to know about. One worker
 * serves every build; each request carries an id so responses find their
 * entry no matter the order they land in.
 */
const WORKER_SOURCE = `"use strict";
const buildLevels = ${buildLevels.toString()};
self.onmessage = (e) => {
  const { id, data, baseBucket, levelStride } = e.data;
  const levels = buildLevels(data, baseBucket, levelStride);
  self.postMessage({ id, levels }, levels.map((level) => level.buffer));
};`;

const inFlight = new Map<
  number,
  { data: Float32Array; resolve: (levels: Float64Array[] | null) => void }
>();
let nextBuildId = 0;

/**
 * Builds waiting for their turn at the worker. Jobs are handed over one at a
 * time, each starting in its own task: handing a buffer to the worker costs
 * a copy on this thread, and a burst of first summaries - a session loading
 * twelve tracks - must not pay twelve copies before its first paint. The
 * copy itself is a slice with the buffer transferred, which moves at memcpy
 * speed instead of the structured-clone serializer's.
 */
const buildQueue: number[] = [];
let postScheduled = false;

function pumpBuildQueue() {
  if (postScheduled || buildQueue.length === 0) return;
  postScheduled = true;

  setTimeout(() => {
    postScheduled = false;

    const id = buildQueue.shift();
    if (id === undefined) return;

    const job = inFlight.get(id);
    const worker = getBuildWorker();

    if (job === undefined) {
      pumpBuildQueue();
      return;
    }

    if (worker === null) {
      // the worker died while this job queued; resolve on this thread
      inFlight.delete(id);
      job.resolve(null);
      pumpBuildQueue();
      return;
    }

    const copy = job.data.slice();
    worker.postMessage(
      { id, data: copy, baseBucket: BASE_BUCKET, levelStride: LEVEL_STRIDE },
      [copy.buffer]
    );
  }, 0);
}

/** undefined = not tried yet, null = unavailable here. */
let buildWorker: Worker | null | undefined;

function getBuildWorker(): Worker | null {
  if (buildWorker !== undefined) return buildWorker;

  try {
    const url = URL.createObjectURL(
      new Blob([WORKER_SOURCE], { type: "text/javascript" })
    );
    // The worker holds its own reference to the script once constructed, so
    // the URL can be released immediately.
    buildWorker = new Worker(url);
    URL.revokeObjectURL(url);

    buildWorker.onmessage = (e: MessageEvent) => {
      const job = inFlight.get(e.data.id);
      inFlight.delete(e.data.id);
      job?.resolve(e.data.levels);

      // the next queued build gets its turn now that this one is done
      pumpBuildQueue();
    };

    // A worker that dies mid-build would otherwise leave summaries
    // approximate forever: finish its outstanding work here, and stop
    // handing it new builds.
    buildWorker.onerror = () => {
      buildWorker?.terminate();
      buildWorker = null;

      const outstanding = [...inFlight.values()];
      inFlight.clear();
      buildQueue.length = 0;
      outstanding.forEach((job) => job.resolve(null));
    };
  } catch {
    buildWorker = null;
  }

  return buildWorker;
}

/**
 * Hand back the pyramid for a buffer, or kick off its build and hand back
 * null. The build runs in a worker when one is available - copying the
 * buffer over costs a few milliseconds against ~20ms of build per three
 * minutes of audio, and none of it blocks painting - and synchronously here
 * when not. onReady fires once the pyramid lands; callers pass a stable
 * function so waiting twice registers once.
 */
function requestPyramid(
  data: Float32Array,
  onReady: () => void
): { pyramid: AudioPyramid | null; started: boolean } {
  let entry = PYRAMIDS.get(data);
  let started = false;

  if (entry === undefined) {
    entry = { pyramid: null, waiters: new Set() };
    PYRAMIDS.set(data, entry);
    started = true;

    const worker = data.length > 0 ? getBuildWorker() : null;

    if (worker === null) {
      entry.pyramid = new AudioPyramid(
        buildLevels(data, BASE_BUCKET, LEVEL_STRIDE)
      );
    } else {
      const settled = entry;
      const id = nextBuildId++;

      pendingBuilds++;
      inFlight.set(id, {
        data,
        resolve: (levels) => {
          // levels is null when the worker died; rebuild here rather than
          // staying approximate for the lifetime of the buffer
          settled.pyramid = new AudioPyramid(
            levels ?? buildLevels(data, BASE_BUCKET, LEVEL_STRIDE)
          );
          pendingBuilds--;

          const waiters = [...settled.waiters];
          settled.waiters.clear();
          waiters.forEach((waiter) => waiter());
        },
      });

      buildQueue.push(id);
      pumpBuildQueue();
    }
  }

  if (entry.pyramid === null) entry.waiters.add(onReady);

  return { pyramid: entry.pyramid, started };
}

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
   * Called when a pyramid this cache was waiting on lands. The owner should
   * re-summarize and repaint: summaries produced before the pyramid existed
   * are decimated approximations, flagged like snapped ones so any exact
   * pass recomputes them.
   */
  onReady?: () => void;

  /** Stable identity so waiting on several builds registers once each. */
  #notifyReady = () => {
    this.onReady?.();
  };

  /**
   * Resolve when the pyramid for a buffer is ready, starting the build if
   * nothing has yet. Rendering never needs this - it starts approximate and
   * refines through onReady - but a caller that wants exact numbers from
   * the first summarize, like a test, can await it.
   */
  prepare(data: Float32Array): Promise<void> {
    return new Promise((resolve) => {
      const { pyramid } = requestPyramid(data, resolve);
      if (pyramid !== null) resolve();
    });
  }

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

    let { drawData, gaps, snapped } = this.#reuseCachedData(
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
        if (pyramid !== null) {
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
        } else {
          // The pyramid is still building. Paint something now rather than
          // block on it: a decimated scan, exactly the summarizer this
          // library had before pyramids existed.
          summarizeRangeApproximate(
            data,
            drawData,
            startPixel,
            from,
            to,
            spp,
            this.#stats
          );
        }
      }

      // Approximate pixels wear the snapped flag whatever was asked for, so
      // the exact pass that follows onReady throws them away wholesale
      // instead of trusting them.
      if (pyramid === null) snapped = true;
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
      // Anything above zero means summaries are still approximate and a
      // refine will land shortly; at rest this must read 0.
      pyramidsPending: pendingBuilds,
    };
  }

  #getPyramid(data: Float32Array) {
    const { pyramid, started } = requestPyramid(data, this.#notifyReady);

    if (started) {
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

/**
 * Compute pixels [from, to) the way this library did before pyramids: every
 * `skip`th sample, so a transient shorter than the decimation step can be
 * missed. This only ever paints while a pyramid is still building - the
 * summaries it produces are flagged for replacement, and the exact pass
 * that follows the build's completion recomputes them from the pyramid.
 */
function summarizeRangeApproximate(
  data: Float32Array,
  drawData: DrawData,
  startPixel: number,
  from: number,
  to: number,
  spp: number,
  stats: { sampleReads: number }
) {
  const skip = Math.max(1, Math.ceil(spp / FALLBACK_RESOLUTION));
  const length = data.length;

  for (let pixel = from; pixel < to; pixel++) {
    const first = Math.round((startPixel + pixel) * spp);
    const last = Math.round((startPixel + pixel + 1) * spp);

    const start = Math.max(first, 0);
    const end = Math.min(last, length);

    let min = 0;
    let max = 0;
    let rms = 0;

    if (end > start) {
      let sumSquares = 0;
      let count = 0;

      for (let i = start; i < end; i += skip, count++) {
        const val = data[i];
        min = Math.min(min, val);
        max = Math.max(max, val);
        sumSquares += val * val;
      }

      rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;
      stats.sampleReads += count;
    } else if (start < length) {
      // Fewer than one sample per pixel; see summarizeRange, this is the
      // same interpolated read.
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
    drawData[offset + 2] = Math.max(min, -rms);
    drawData[offset + 3] = Math.min(max, rms);
  }
}
