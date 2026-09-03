#!/usr/bin/env node
/** Verifies local-dev Environment secrets injected by op run (names only). */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLocalDevSecrets, formatMissingAgenticNote } from "./lib/local-dev-secrets.mjs";
import { parseManifestKeys } from "./lib/parse-manifest-keys.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const examplePath = path.join(repoRoot, "apps/web/.dev.vars.example");

const manifest = readFileSync(examplePath, "utf8");
const manifestKeys = parseManifestKeys(manifest);
const {
  requiredKeys,
  optionalKeys,
  agenticKeys,
  unknownRequired,
  missingRequired,
  missingOptional,
  missingAgentic,
  presentRequired,
  presentOptional,
  presentAgentic,
} = classifyLocalDevSecrets(manifestKeys);

if (unknownRequired.length > 0) {
  console.error(
    `FAIL: required local keys missing from apps/web/.dev.vars.example: ${unknownRequired.join(", ")}`,
  );
  process.exit(1);
}

const presentCount =
  presentRequired.length + presentOptional.length + presentAgentic.length;
const totalCount =
  requiredKeys.length + optionalKeys.length + agenticKeys.length;
console.log(
  `OK: ${presentCount}/${totalCount} manifest keys have values (${presentRequired.length}/${requiredKeys.length} required)`,
);
const presentListed = [...presentRequired, ...presentOptional, ...presentAgentic];
if (presentListed.length > 0) {
  console.log(`present: ${presentListed.join(", ")}`);
}

if (missingRequired.length > 0) {
  console.error(`FAIL: missing or empty required keys: ${missingRequired.join(", ")}`);
  console.error(
    "hint: set APP_ENV, APP_ORIGIN, CLERK_SECRET_KEY, and CLERK_PUBLISHABLE_KEY in your personal Environment (or export them in the shell). Prefer OP_ENVIRONMENT_ID in apps/web/.op/refs.env + op sign-in; cloud agents — OP_SERVICE_ACCOUNT_TOKEN + OP_ENVIRONMENT_ID.",
  );
  process.exit(1);
}

if (missingOptional.length > 0) {
  console.log(
    `note: optional keys not set (ok for first-run): ${missingOptional.join(", ")}`,
  );
}

const agenticNote = formatMissingAgenticNote(missingAgentic);
if (agenticNote) {
  console.log(agenticNote);
}

console.log("PASS: local-dev Environment has required secrets");
