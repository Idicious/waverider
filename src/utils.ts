import type { ModifierKey, Selection } from "./types";

export const ALWAYS = () => true;

/** Just the parts of an event the modifier check needs. */
export type ModifierEvent = { metaKey: boolean; ctrlKey: boolean };

let platformModifier: ModifierKey | null = null;

/**
 * Cmd on macOS, Ctrl everywhere else, matching what each platform uses for
 * the equivalent gestures in native applications.
 */
export function getPlatformModifierKey(): ModifierKey {
  if (platformModifier !== null) return platformModifier;

  // userAgentData is not on Safari or Firefox, and navigator.platform is
  // deprecated but still the only thing present everywhere.
  const platform =
    (navigator as any).userAgentData?.platform ?? navigator.platform ?? "";

  platformModifier = /mac|iphone|ipad|ipod/i.test(platform) ? "meta" : "ctrl";
  return platformModifier;
}

export function hasModifier(e: ModifierEvent, key: ModifierKey) {
  return key === "meta" ? e.metaKey : e.ctrlKey;
}

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
