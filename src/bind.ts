export const COLOR_TOLERANCE = 10;

let nextCol = 0;
export function genColor() {
  if (nextCol < 16777215) {
    nextCol += COLOR_TOLERANCE;
  }
  return nextCol;
}

export function rgbToNumber(rgb: Uint8ClampedArray) {
  return (rgb[0] << 16) + (rgb[1] << 8) + rgb[2];
}

export function roundToClosestMultipleOf(num: number, multiple: number) {
  return Math.round(num / multiple) * multiple;
}

export function numberToRGBString(num: number) {
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  return `rgb(${r},${g},${b})`;
}

export const BIND_ATTR = "unique-bind-id";
