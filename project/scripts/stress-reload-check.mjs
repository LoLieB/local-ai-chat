import { probePublicApp, probeUrl, resolveDistAssetProbePath } from "./tunnel-probes.mjs";

const publicUrl = process.argv[2];

if (!publicUrl) {
  console.error("Usage: node scripts/stress-reload-check.mjs https://your-subdomain.loca.lt");
  process.exit(1);
}

const assetPath = resolveDistAssetProbePath();

for (let index = 1; index <= 60; index += 1) {
  const local = await probeUrl("http://127.0.0.1:8787/api/health");
  const app = await probePublicApp(publicUrl, assetPath);

  console.log(
    `[${index}] local=${local.status}(${local.durationMs}ms) api=${app.publicHealth.status}(${app.publicHealth.durationMs}ms) html=${app.publicHtml.status}(${app.publicHtml.durationMs}ms) asset=${app.publicAsset.status}(${app.publicAsset.durationMs}ms)`
  );

  await new Promise((resolve) => setTimeout(resolve, 500));
}
