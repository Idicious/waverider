import { Selection } from "./types";

export const ALWAYS = () => true;

export function invertYScale(yScale: d3.ScaleBand<string>, y: number) {
  const eachBand = yScale.step();
  const index = Math.floor(y / eachBand);
  return yScale.domain()[index];
}

export type ArrayItem<T> = T extends Array<infer U> ? U : never;

export function getSelection(
  start: [number, number],
  end: [number, number]
): Selection {
  return {
    x1: Math.min(start[0], end[0]),
    x2: Math.max(start[0], end[0]),
    y1: Math.min(start[1], end[1]),
    y2: Math.max(start[1], end[1]),
  };
}

export function getDrawValue(n: number, toHidden: boolean) {
  return toHidden ? Math.round(n) : n;
}
