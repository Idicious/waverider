/// We want to treat the zoom level in terms of samples per pixel, instead of the zoom factor.
/// This way we can keep the zoom level consistent across different zoom levels and screen sizes.
/// In order to do this we have to convert between d3 domain and range values and samples per pixel.

export function getDomainInMs(
  startMs: number,
  samplesPerPixel: number,
  sampleRate: number, // e.g. 44100
  widthInPixels: number
) {
  const durationInSeconds = (widthInPixels * samplesPerPixel) / sampleRate;
  return [startMs, startMs + Math.floor(durationInSeconds * 1000)];
}

export function getSamplesPerPixel(
  durationInMs: number,
  sampleRate: number,
  width: number
) {
  return (sampleRate * (durationInMs / 1000)) / width;
}
