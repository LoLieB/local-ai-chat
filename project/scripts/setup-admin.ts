import { initializeAdmin } from "../server/storage/authStore.js";

try {
  if (await initializeAdmin()) process.exit(0);
  if (process.argv.includes("--check")) process.exit(10);
  let password = "";
  for await (const chunk of process.stdin) password += chunk;
  await initializeAdmin(password);
} catch {
  // Credential values and parser diagnostics must never reach console output.
  console.error("Administrator setup failed. Check password length and data folder access.");
  process.exitCode = 1;
}
