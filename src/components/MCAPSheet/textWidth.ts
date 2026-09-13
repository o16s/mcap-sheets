const FONT_FAMILY = 'Inter, Roboto, "Helvetica Neue", Arial, sans-serif';
export const CELL_FONT = `12px ${FONT_FAMILY}`;
export const HEADER_FONT = `600 12px ${FONT_FAMILY}`;

let canvas: HTMLCanvasElement | undefined;

/**
 * Measures the rendered pixel width of a string in the given font, using a
 * shared offscreen canvas. Falls back to a rough monospace estimate if a 2D
 * context is unavailable (e.g. in a non-DOM test environment).
 */
export const measureTextWidth = (text: string, font: string = CELL_FONT): number => {
  canvas ??= document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    return text.length * 7;
  }
  context.font = font;
  return context.measureText(text).width;
};
