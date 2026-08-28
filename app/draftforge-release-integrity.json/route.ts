import {
  readServedReleaseManifest,
} from "../lib/release-integrity-response.ts";

export const dynamic = "force-dynamic";

function failure(code: string, status: number) {
  return Response.json({ ok: false, code }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

type ManifestReader = () => Promise<Uint8Array>;

export async function serveReleaseIntegrityManifest(
  request: Request,
  readManifest: ManifestReader = readServedReleaseManifest,
) {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return failure("RELEASE_INTEGRITY_REQUEST_INVALID", 400);
  }
  if (url.search) return failure("RELEASE_INTEGRITY_QUERY_NOT_SUPPORTED", 400);

  try {
    const bytes = await readManifest();
    return new Response(bytes, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(bytes.byteLength),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    // Do not expose local paths or fs/runtime details. A missing, oversized, or
    // malformed release envelope keeps the production supervisor fail-closed.
    return failure("RELEASE_INTEGRITY_MANIFEST_UNAVAILABLE", 503);
  }
}

export async function GET(request: Request) {
  return serveReleaseIntegrityManifest(request);
}
