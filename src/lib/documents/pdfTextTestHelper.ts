import { inflateSync } from "node:zlib";

/**
 * Test-only helper: extracts the literal text pdf-lib drew into a generated PDF's content streams,
 * so a test can assert on what a human (or a naive grep of the file) would actually see — pdf-lib
 * Flate-compresses content streams by default and renders drawText() calls as PDF hex strings
 * (`<...> Tj`), so a plain substring search against the raw saved bytes silently finds nothing even
 * when the text is present; this decompresses each stream and decodes both hex (`<...>`) and literal
 * (`(...)`) string operands preceding a `Tj` show-text operator.
 */
export function extractPdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const t = buf.toString("latin1");
  let idx = 0;
  const pieces: string[] = [];
  while (true) {
    const s = t.indexOf("stream", idx);
    if (s === -1) break;
    let dataStart = s + 6;
    if (t[dataStart] === "\r") dataStart++;
    if (t[dataStart] === "\n") dataStart++;
    const e = t.indexOf("endstream", dataStart);
    if (e === -1) break;
    const segment = buf.subarray(dataStart, e);
    let content: string;
    try {
      content = inflateSync(segment).toString("latin1");
    } catch {
      content = segment.toString("latin1");
    }
    for (const m of content.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
      pieces.push(Buffer.from((m[1] ?? "").replace(/\s+/g, ""), "hex").toString("latin1"));
    }
    for (const m of content.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
      pieces.push(m[1] ?? "");
    }
    idx = e + 9;
  }
  return pieces.join(" ");
}
