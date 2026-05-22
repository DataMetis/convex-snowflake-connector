/**
 * Best-effort reachability probe for a Convex deployment. Used by `init` and
 * (eventually) `doctor`. Deliberately shallow: it confirms the URL responds
 * and looks like a Convex deployment. Deep auth validation happens at first
 * real call (export / paginated read) so we don't bake assumptions about
 * private endpoints into this module.
 */

export interface ConvexProbeInput {
  url: string;
  /** Reserved for future authenticated checks — accepted but unused today. */
  deployKey?: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Connect/read timeout in ms. */
  timeoutMs?: number;
}

export interface ConvexProbeResult {
  ok: boolean;
  url: string;
  /** Round-trip time of the probe request, in ms. */
  latencyMs: number;
  /** Convex backend version string, if the deployment reported one. */
  version?: string;
  /** Populated when `ok` is false. Human-readable, names the likely fix. */
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

function parseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function describeFetchError(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === "AbortError") {
    return `timed out after ${timeoutMs}ms`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function probeConvex(
  input: ConvexProbeInput,
): Promise<ConvexProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const normalizedUrl = parseUrl(input.url);
  if (normalizedUrl === null) {
    return {
      ok: false,
      url: input.url,
      latencyMs: 0,
      error: `"${input.url}" is not a valid URL. Expected something like https://flying-mongoose-123.convex.cloud`,
    };
  }

  // Convex deployments expose /version returning a quoted version string.
  // Unauthenticated and cheap — the right shape for a reachability probe.
  const versionUrl = new URL("/version", normalizedUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const res = await fetchImpl(versionUrl, { signal: controller.signal });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return {
        ok: false,
        url: normalizedUrl.toString(),
        latencyMs,
        error: `Convex deployment responded ${res.status} at ${versionUrl}. Check the URL is correct.`,
      };
    }
    const body = (await res.text()).trim().replace(/^"|"$/g, "");
    return {
      ok: true,
      url: normalizedUrl.toString(),
      latencyMs,
      ...(body !== "" ? { version: body } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      url: normalizedUrl.toString(),
      latencyMs: Date.now() - start,
      error: `Could not reach Convex at ${versionUrl} (${describeFetchError(err, timeoutMs)}). Check the deployment URL and your network.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
