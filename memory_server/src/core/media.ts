import { MemoryError } from "./errors.js";

/**
 * Binary documents the store accepts, by extension. Only media that a browser cannot run as code:
 * no SVG, no HTML, since the web app serves them from its own origin.
 */
export const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".webm": "video/webm",
};

const SIGNATURES: Record<string, (data: Buffer) => boolean> = {
  "image/png": (d) => d.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (d) => d.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  "image/gif": (d) => ["GIF87a", "GIF89a"].includes(d.subarray(0, 6).toString("latin1")),
  "image/webp": (d) => d.subarray(0, 4).toString("latin1") === "RIFF" && d.subarray(8, 12).toString("latin1") === "WEBP",
  "video/webm": (d) => d.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
};

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Media type of a path from its extension; undefined for a text document. */
export function mediaTypeOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? undefined : MEDIA_TYPES[name.slice(dot).toLowerCase()];
}

function extensions(): string {
  return Object.keys(MEDIA_TYPES).join(", ");
}

/** The media type of a binary document at `path`, after checking the extension, the declared type and the content. */
export function checkMedia(path: string, data: Buffer, declared?: string): string {
  const type = mediaTypeOf(path);
  if (type === undefined) {
    throw new MemoryError("INVALID_ARGUMENT", `${path} is not a binary document path: binary documents need one of the extensions ${extensions()}`,
      { path });
  }
  if (declared !== undefined && declared !== type) {
    throw new MemoryError("INVALID_ARGUMENT", `Content type ${declared} does not match the extension of ${path} (${type})`,
      { path, content_type: declared, expected: type });
  }
  if (!SIGNATURES[type]!(data)) {
    throw new MemoryError("INVALID_ARGUMENT", `The content of ${path} is not a valid ${type} file`, { path, content_type: type });
  }
  return type;
}

/** Decodes base64 data, rejecting anything that is not base64 (whitespace is ignored). */
export function decodeBase64(path: string, text: string): Buffer {
  const compact = text.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !BASE64.test(compact)) {
    throw new MemoryError("INVALID_ARGUMENT", `file_text of ${path} is not valid base64`, { path });
  }
  return Buffer.from(compact, "base64");
}
