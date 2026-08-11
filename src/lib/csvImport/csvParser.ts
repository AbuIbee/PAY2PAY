/**
 * Minimal, dependency-free CSV parser (basic RFC 4180 support: quoted fields, embedded commas,
 * escaped `""` quotes, CRLF/LF line endings). Sprint 8's CSV import doesn't need a full spec-
 * compliant library — this covers what a typical spreadsheet export produces.
 */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (char === "\r") {
      i++;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += char;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && (r[0] ?? "").trim() === ""));
}

export interface ParsedCsvTable {
  headers: string[];
  rows: string[][];
}

export function parseCsvWithHeader(content: string): ParsedCsvTable {
  const allRows = parseCsv(content);
  const [headerRow, ...dataRows] = allRows;
  const headers = (headerRow ?? []).map((h) => h.trim().toLowerCase());
  return { headers, rows: dataRows };
}
