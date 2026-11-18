import { mkdir, readdir, copyFile, writeFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// Explicit source allowlist keeps private state and internal handoffs out of releases.
export async function exportSource(destination, root = fileURLToPath(new URL("../", import.meta.url))) {
  await mkdir(destination, { recursive: false });
  const files = ["package.json", "package-lock.json", "index.html", "vite.config.ts",
    "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", ".gitignore", ".env.example",
    "README.md", "README.ru.md", "LICENSE", "RELEASE-NOTES.md", "RELEASE-NOTES.ru.md", "THIRD-PARTY-NOTICES.md"];
  async function collect(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Symlink not allowed: ${path}`);
      if (entry.isDirectory()) await collect(path);
      else if ([".ts", ".tsx", ".css", ".mjs"].includes(extname(path))) files.push(path);
    }
  }
  for (const directory of ["src", "server", "shared", "scripts", "tests"]) await collect(directory);
  const studio = ["muse","luma","rowan","vesper","ivo","orrin","mira",...Array.from({length:14},(_,i)=>"portrait-"+String(i+1).padStart(2,"0"))];
  files.push(...studio.flatMap(id=>[id+".webp",id+"-sm.webp"]).concat(["mark.svg","mark-light.svg","mark-mono.svg","wordmark.svg","icon-32.png","icon-180.png","icon-192.png","icon-512.png","ASSETS.md"]).map(name=>"public/studio/"+name));
  // Optional artwork has no recorded provenance; keep it local until redistribution is confirmed.
  const hashes = [];
  for (const file of files.sort()) {
    const target = join(destination, file);
    await mkdir(resolve(target, ".."), { recursive: true });
    await copyFile(join(root, file), target);
    hashes.push(`${createHash("sha256").update(await readFile(target)).digest("hex")}  ${file}`);
  }
  await writeFile(join(destination, "SHA256SUMS.txt"), hashes.join("\n") + "\n");
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/release-source.mjs NEW_DIRECTORY");
  console.log(`Exported ${(await exportSource(resolve(process.argv[2]))).length} source files.`);
}
