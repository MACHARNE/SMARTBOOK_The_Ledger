const { spawnSync } = require("node:child_process");

// Supabase CLI is the single migration authority. It reads the standard
// ../../supabase/migrations directory and records versions in
// supabase_migrations.schema_migrations.
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, [
  "--yes",
  "supabase@2.121.0",
  "db",
  "push",
  "--workdir",
  "..",
  "--skip-vault",
  ...(process.argv.includes("--dry-run") ? ["--dry-run"] : []),
], {
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error("Could not start the Supabase CLI:", result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
