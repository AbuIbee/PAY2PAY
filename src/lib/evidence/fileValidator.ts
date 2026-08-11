export interface FileValidationInput {
  fileName: string;
  contentType: string;
  content: Uint8Array;
}

export type FileValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * Sprint 7 (docs/sprints/SPRINT_07_Evidence_Documents_Witnesses.md) "malware/file validation
 * abstraction." Real implementation: BasicFileValidator.
 */
export interface FileValidator {
  validate(input: FileValidationInput): Promise<FileValidationResult>;
}

export const MAX_EVIDENCE_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

/** Extension -> allowed content types. Ordinary business-document formats only. */
export const ALLOWED_EVIDENCE_TYPES: Record<string, string[]> = {
  ".pdf": ["application/pdf"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".heic": ["image/heic"],
  ".doc": ["application/msword"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".xls": ["application/vnd.ms-excel"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
};

// A short list of unambiguous magic-byte signatures, used only to catch a mismatched/disguised
// file (e.g. an executable renamed to "invoice.pdf") — not a substitute for real virus scanning.
const KNOWN_SIGNATURES: { prefix: number[]; matches: (contentType: string, ext: string) => boolean }[] = [
  { prefix: [0x25, 0x50, 0x44, 0x46], matches: (_, ext) => ext === ".pdf" }, // %PDF
  { prefix: [0x89, 0x50, 0x4e, 0x47], matches: (_, ext) => ext === ".png" }, // PNG
  { prefix: [0xff, 0xd8, 0xff], matches: (_, ext) => ext === ".jpg" || ext === ".jpeg" }, // JPEG
];

const DANGEROUS_SIGNATURES: { prefix: number[]; label: string }[] = [
  { prefix: [0x4d, 0x5a], label: "Windows executable (MZ header)" }, // MZ
  { prefix: [0x7f, 0x45, 0x4c, 0x46], label: "ELF executable" },
  { prefix: [0x23, 0x21], label: "script with a shebang line" }, // #!
];

function getExtension(fileName: string): string {
  const match = /\.[a-z0-9]+$/i.exec(fileName.trim());
  return match ? match[0].toLowerCase() : "";
}

function startsWith(content: Uint8Array, prefix: number[]): boolean {
  if (content.length < prefix.length) return false;
  return prefix.every((byte, index) => content[index] === byte);
}

/**
 * Synchronous, dependency-free checks only — no real antivirus/malware-scanning provider is
 * integrated in this environment (docs/ARCHITECTURE.md lists one as an unintegrated external
 * service dependency). This validates size, extension/content-type allowlisting, and a handful of
 * unambiguous magic-byte signatures (both to catch disguised executables and to reject an
 * extension/content mismatch) — it is not a substitute for real virus scanning and must not be
 * described as one.
 */
export class BasicFileValidator implements FileValidator {
  async validate(input: FileValidationInput): Promise<FileValidationResult> {
    if (input.content.byteLength === 0) {
      return { ok: false, reason: "The file is empty." };
    }
    if (input.content.byteLength > MAX_EVIDENCE_FILE_SIZE_BYTES) {
      return { ok: false, reason: `The file exceeds the ${MAX_EVIDENCE_FILE_SIZE_BYTES / (1024 * 1024)} MB limit.` };
    }

    const extension = getExtension(input.fileName);
    const allowedContentTypes = ALLOWED_EVIDENCE_TYPES[extension];
    if (!allowedContentTypes) {
      return { ok: false, reason: `File type "${extension || "(none)"}" is not an accepted evidence document type.` };
    }
    if (!allowedContentTypes.includes(input.contentType)) {
      return { ok: false, reason: `The file's content type does not match its "${extension}" extension.` };
    }

    for (const dangerous of DANGEROUS_SIGNATURES) {
      if (startsWith(input.content, dangerous.prefix)) {
        return { ok: false, reason: `Rejected: file content looks like a ${dangerous.label}, not a document.` };
      }
    }

    const knownSignature = KNOWN_SIGNATURES.find((s) => startsWith(input.content, s.prefix));
    if (knownSignature && !knownSignature.matches(input.contentType, extension)) {
      return { ok: false, reason: "The file's content does not match its declared type." };
    }

    return { ok: true };
  }
}
