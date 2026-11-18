import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export async function probeUrl(url, timeoutMs = 2500) {
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "bypass-tunnel-reminder": "1",
        "cache-control": "no-cache"
      }
    });

    return {
      ok: response.ok,
      status: `${response.status}`,
      durationMs: Date.now() - startedAt,
      contentType: response.headers.get("content-type") || ""
    };
  } catch (error) {
    return {
      ok: false,
      status: `ERR:${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startedAt,
      contentType: ""
    };
  }
}

export function formatProbeResult(result) {
  return `${result.status}(${result.durationMs}ms)`;
}

export function resolveDistAssetProbePath(distPath = resolve(process.cwd(), "dist")) {
  try {
    const html = readFileSync(resolve(distPath, "index.html"), "utf8");
    const scriptMatch = html.match(/<script[^>]+src="([^"]+\.js)"/i);
    if (scriptMatch) {
      return scriptMatch[1];
    }

    const cssMatch = html.match(/<link[^>]+href="([^"]+\.css)"/i);
    if (cssMatch) {
      return cssMatch[1];
    }
  } catch {
    return "";
  }

  return "";
}

export async function probePublicApp(publicUrl, assetPath) {
  if (!publicUrl) {
    const empty = { ok: false, status: "NO_URL", durationMs: 0, contentType: "" };
    return {
      publicHealth: empty,
      publicHtml: empty,
      publicAsset: assetPath ? empty : { ok: false, status: "NO_ASSET", durationMs: 0, contentType: "" }
    };
  }

  const normalizedAssetPath = assetPath
    ? (assetPath.startsWith("/") ? assetPath : `/${assetPath}`)
    : "";

  return {
    publicHealth: await probeUrl(`${publicUrl}/api/health`),
    publicHtml: await probeUrl(`${publicUrl}/`),
    publicAsset: normalizedAssetPath
      ? await probeUrl(`${publicUrl}${normalizedAssetPath}`)
      : { ok: false, status: "NO_ASSET", durationMs: 0, contentType: "" }
  };
}
