/**
 * Word-wrap for canvas text, mirroring openpilot's wrap_text: splits on
 * newlines first, wraps words to fit maxWidth, and hard-breaks words longer
 * than the line. `ctx.font` must already be set before calling.
 */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  if (!text || maxWidth <= 0) return text ? [text] : [];

  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (ctx.measureText(word).width > maxWidth) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(...breakLongWord(ctx, word, maxWidth));
        continue;
      }
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= maxWidth) {
        line = test;
      } else {
        if (line) out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function breakLongWord(
  ctx: CanvasRenderingContext2D,
  word: string,
  maxWidth: number,
): string[] {
  const parts: string[] = [];
  let rem = word;
  while (rem) {
    if (ctx.measureText(rem).width <= maxWidth) {
      parts.push(rem);
      break;
    }
    let lo = 1;
    let hi = rem.length;
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ctx.measureText(rem.slice(0, mid)).width <= maxWidth) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    parts.push(rem.slice(0, best));
    rem = rem.slice(best);
  }
  return parts;
}
