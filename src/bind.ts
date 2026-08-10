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

/** Largest value representable in 24 bits, i.e. rgb(255,255,255). */
const MAX_COLOR = 16777215;

/**
 * Hands out the bind colors for one WaveShaper and takes them back when the
 * element they identified goes away.
 *
 * Colors are multiples of COLOR_TOLERANCE so that a pixel read back from the
 * hit canvas can be rounded onto one even after the canvas has nudged it.
 * Zero is never handed out: a cleared hit canvas reads as rgb(0,0,0), and that
 * has to stay distinguishable from a real element.
 */
export class BindColorAllocator {
  #next = 0;
  #free: number[] = [];

  acquire() {
    const reused = this.#free.pop();
    if (reused !== undefined) return reused;

    const next = this.#next + COLOR_TOLERANCE;

    // Silently reusing the last color here would turn into elements that
    // report each other's identity on click, which is far harder to find than
    // a throw at the point of exhaustion.
    if (next > MAX_COLOR) {
      throw new Error(
        `Out of bind colors: more than ${Math.floor(
          MAX_COLOR / COLOR_TOLERANCE
        )} interactive elements are bound at once`
      );
    }

    this.#next = next;
    return next;
  }

  release(color: number) {
    this.#free.push(color);
  }
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

const RGB_STRING = /^rgb\((\d+),(\d+),(\d+)\)$/;

/**
 * Inverse of numberToRGBString, for turning the color held on an element back
 * into the key it was allocated under. Returns null for anything this module
 * did not produce, including the empty string an unbound element carries.
 */
export function rgbStringToNumber(value: string) {
  const match = RGB_STRING.exec(value);
  if (match === null) return null;

  return (+match[1] << 16) + (+match[2] << 8) + +match[3];
}

