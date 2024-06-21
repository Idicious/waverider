/**
 * Elements are bound to a unique color, which is used to identify them. When we draw the canvas,
 * we also draw to a hidden canvas using the unique color. When there is an interaction we want to
 * get the element that was interacted with, and we can do this by getting the color of the pixel
 * and looking up the element with that color.
 *
 * Tolerance is used because there can be slight variations in the color due to the way the canvas transitions
 * between colors on the edges of elements. In order to prevent tolerance issues always draw to whole pixels,
 * only draw interactive elements to the hidden canvas, and only use straight lines on the hidden canvas.
 * Curves can be used on the display canvas, but the interaction bounds should be rectangular.
 */

export const COLOR_TOLERANCE = 10;

let nextCol = 0;
export function genColor() {
  if (nextCol < 16777215) {
    nextCol += COLOR_TOLERANCE;
  }
  return nextCol;
}

export function toBindColor(rgb: Uint8ClampedArray) {
  return roundToClosestMultipleOf(rgbToNumber(rgb), COLOR_TOLERANCE);
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
