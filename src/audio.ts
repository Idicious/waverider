const RESOLUTION = 128;
const ALLIGNMENT = 128;

export function summarizeAudio(
  data: Float32Array,
  cacheKey: string,
  startMs: number,
  durationMs: number,
  spp: number,
  zoomFactor: number
) {
  let [start, end, drawData, width] = getCachedData(
    cacheKey,
    startMs,
    durationMs,
    spp,
    zoomFactor
  );

  if (start === end) return drawData;
  const skip = Math.ceil(spp / RESOLUTION);

  // Alligning the start sample used for drawing waveforms causes less shifting when introducing cuts and zoom
  const startSample = startMs * 44.1;
  const length = data.length;

  // For each pixel in draw area
  for (; start < end; start++) {
    const pixelStartSample = Math.round(startSample + start * spp);

    let posSum = 0;
    let negSum = 0;
    let count = 0;

    // Iterate over the sample range for this pixel (spp)
    // and find the min and max values.
    for (let j = 0; j < spp; j += skip, count++) {
      const index = pixelStartSample + j;
      if (index < length) {
        const val = data[index];
        if (val > 0) {
          posSum += val * val;
        } else {
          negSum += val * val;
        }
      }
    }

    const min = -Math.sqrt(negSum / count);
    const max = Math.sqrt(posSum / count);

    drawData[start] = [min, max];
  }

  cache.set(cacheKey, {
    startMs,
    durationMs,
    spp,
    drawData,
    width,
    zoomFactor,
  });

  return drawData;
}

export interface CacheData {
  startMs: number;
  durationMs: number;
  spp: number;
  width: number;
  zoomFactor: number;
  drawData: DrawData;
}
export type DrawData = [number, number][];

const cache = new Map<string, CacheData>();

export function getCachedData(
  key: string,
  startMs: number,
  durationMs: number,
  spp: number,
  zoomFactor: number
): [number, number, DrawData, number] {
  const width = msToPx(durationMs, spp);

  const cached = cache.get(key);

  // if there is no cache or zoom level has changed we need to re-calculate
  if (cached == null || cached.zoomFactor !== zoomFactor) {
    return [0, width, new Array(width), width];
  }

  /**
   * |-----cached---|
   * |-----new------|
   */
  if (cached.startMs === startMs && cached.durationMs === durationMs) {
    return [0, 0, cached.drawData, width];
  }

  /**
   * |-----cached---|
   * |-----new---|
   */
  if (cached.startMs === startMs && cached.durationMs > durationMs) {
    // console.log("cached start complete");
    return [0, 0, cached.drawData.slice(0, width), width];
  }

  const cachedEnd = cached.startMs + cached.durationMs;
  const newEnd = startMs + durationMs;

  /**
   * |-----cached---|
   *    |----new----|
   */
  if (cachedEnd === newEnd && cached.startMs < startMs) {
    // console.log("cached end complete");

    const diff = msToPx(startMs - cached.startMs, spp);
    return [0, 0, cached.drawData.slice(diff), width];
  }

  /**
   * |-----cached---|
   * |-----new----------|
   */
  if (cached.startMs === startMs && cached.durationMs < durationMs) {
    // console.log("cached start partial");

    const diff = msToPx(newEnd - cachedEnd, spp);
    const newDataArr = new Array(diff).fill([0, 0]);
    const drawData = cached.drawData.concat(newDataArr);
    return [width - diff, width, drawData, width];
  }

  /**
   *    |-----cached----|
   * |-----new----------|
   */
  if (cachedEnd === newEnd && cached.startMs > startMs) {
    // console.log("cached end partial");

    // const diff = width - cached.drawData.length;
    const diff = msToPx(cached.startMs - startMs, spp);
    const newDataArr = new Array(diff).fill([0, 0]);
    const drawData = newDataArr.concat(cached.drawData);

    return [0, diff, drawData, width];
  }

  // if the cached time window partially overlaps the new time window
  if (
    cached.startMs < newEnd &&
    cachedEnd > startMs &&
    cached.width === width
  ) {
    // const shift = msToPx(startMs - cached.startMs, spp);
    const shift = startMs - cached.startMs;

    const shiftLeft = shift < 0;
    const shiftRight = shift > 0;
    const shiftPx = Math.abs(msToPx(shift, spp));
    const newDataArr = new Array(shiftPx).fill([0, 0]);

    /**
     * |-----cached---|
     *   |------new-----|
     */
    if (shiftRight) {
      // console.log("shift right");
      const reUse = cached.drawData.slice(shiftPx);
      const drawData = reUse.concat(newDataArr);

      return [width - shiftPx, width, drawData, width];
    }

    /**
     *   |-----cached---|
     * |------new-----|
     */
    if (shiftLeft) {
      // console.log("shift left");
      const reUse = cached.drawData.slice(0, width - shiftPx);
      const drawData = newDataArr.concat(reUse);

      return [0, shiftPx, drawData, width];
    }
  }

  // no overlap between cached and new time window
  return [0, width, new Array(width), width];
}

function msToPx(ms: number, spp: number) {
  return Math.round((ms * 44.1) / spp);
}
