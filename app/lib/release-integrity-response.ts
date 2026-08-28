import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const MAX_SERVED_RELEASE_MANIFEST_BYTES = 256 * 1024;

type ReadFile = (path: string) => Promise<Uint8Array>;

export async function readServedReleaseManifest({
  manifestPath = resolve(process.cwd(), "dist/client/draftforge-release-integrity.json"),
  readFileImpl = readFile,
  maxBytes = MAX_SERVED_RELEASE_MANIFEST_BYTES,
}: {
  manifestPath?: string;
  readFileImpl?: ReadFile;
  maxBytes?: number;
} = {}) {
  const bytes = await readFileImpl(manifestPath);
  if (bytes.byteLength === 0) throw new Error("RELEASE_INTEGRITY_MANIFEST_EMPTY");
  if (bytes.byteLength > maxBytes) throw new Error("RELEASE_INTEGRITY_MANIFEST_TOO_LARGE");

  // The startup supervisor performs the authoritative schema, digest, and
  // asset verification. This lightweight parse keeps the route fail-closed if
  // the post-build artifact is absent or corrupt without changing its bytes.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("RELEASE_INTEGRITY_MANIFEST_INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RELEASE_INTEGRITY_MANIFEST_INVALID_JSON");
  }

  return new Uint8Array(bytes);
}
