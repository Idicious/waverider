export const ALWAYS = () => true;

export function invertYScale(yScale: d3.ScaleBand<string>, y: number) {
  const eachBand = yScale.step();
  const index = Math.floor(y / eachBand);
  return yScale.domain()[index];
}
