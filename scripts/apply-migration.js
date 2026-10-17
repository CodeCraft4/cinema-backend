#!/usr/bin/env node
"use strict";

/**
 * Applies supabase/migrations/*.sql to your hosted project through the
 * Supabase Management API — no CLI, no psql, no database password required.
 *
 *   npm run db:migrate            # apply every pending migration (in order)
 *   npm run db:migrate -- --dry-run
 *   npm run db:migrate -- --file=supabase/migrations/20260923120000_create_media_content.sql
 *
 * Requires a Personal Access Token in .env:
 *   SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxx
 * Create one at https://supabase.com/dashboard/account/tokens
 *
 * Endpoint (verified against the Management API reference):
 *   POST https://api.supabase.com/v1/projects/{ref}/database/query
 *   Authorization: Bearer <PAT>,  body: { "query": "<sql>" }
 *
 * The migration SQL is idempotent (IF NOT EXISTS / CREATE OR REPLACE /
 * DROP TRIGGER IF EXISTS), so re-running this is always safe.
 */

const dns = require("dns");
const fs = require("fs");
const path = require("path");

dns.setDefaultResultOrder("ipv4first");

const env = require("../server/config/env");
const { getSupabaseClient } = require("../server/services/supabaseClient");

const ROOT_DIR = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT_DIR, "supabase", "migrations");
const TABLE = "media_content";
const TABLE_COLUMNS = ["id", "external_id", "source", "title", "media_type", "details", "created_at", "updated_at"];

function parseArgs() {
  const fileArg = process.argv.find((arg) => arg.startsWith("--file="));
  return {
    dryRun: process.argv.includes("--dry-run"),
    file: fileArg ? path.resolve(ROOT_DIR, fileArg.split("=")[1]) : null,
  };
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => path.join(MIGRATIONS_DIR, name));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchFailureDetail(error) {
  const cause = error?.cause;
  const nested = cause?.cause;
  return [error?.message, cause?.code, cause?.message, nested?.code, nested?.message].filter(Boolean).join(" — ");
}

/** Sends one SQL statement batch to the Management API. Retries a dropped connection. */
async function runQuery(sql) {
  const url = `https://api.supabase.com/v1/projects/${env.supabaseProjectRef}/database/query`;
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.supabaseAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: sql }),
      });
      return await readQueryResponse(response);
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      await sleep(1000 * attempt);
    }
  }
  const detail = fetchFailureDetail(lastError);
  throw new Error(detail || "fetch failed");
}

async function readQueryResponse(response) {

  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = raw;
  }

  return { ok: response.ok, status: response.status, body: parsed, raw };
}

function explainApiFailure(result) {
  const message = typeof result.body === "object" ? result.body?.message || result.body?.error : result.body;
  if (result.status === 401) {
    return "401 Unauthorized — SUPABASE_ACCESS_TOKEN is missing, wrong or expired. Create a new token at https://supabase.com/dashboard/account/tokens";
  }
  if (result.status === 403) {
    return "403 Forbidden — the token lacks database:write scope, or belongs to a different organisation.";
  }
  if (result.status === 404) {
    return `404 Not Found — project ref "${env.supabaseProjectRef}" was not found for this account. Set SUPABASE_PROJECT_REF in .env if it is wrong.`;
  }
  if (result.status === 429) return "429 Too Many Requests — retry in a moment.";
  return `${result.status} — ${message || result.raw || "unknown Management API error"}`;
}

/**
 * Post-apply verification through the REST API:
 *   • the table is visible to PostgREST
 *   • every expected column exists
 *   • external_id really is UNIQUE (read back via the Management API)
 */
async function verifyTable() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from(TABLE).select(TABLE_COLUMNS.join(",")).limit(1);

  if (error) return { ok: false, reason: "PostgREST cannot read the table yet", detail: `${error.code}: ${error.message}` };

  const columns = new Set(Object.keys(data[0] || {}));
  const missingColumns = TABLE_COLUMNS.filter((column) => column !== "created_at" && column !== "updated_at" && !columns.has(column));

  const constraint = await runQuery(
    `select conname, contype from pg_constraint
      where conrelid = 'public.${TABLE}'::regclass and contype = 'u';`
  );
  const constraints = Array.isArray(constraint.body) ? constraint.body : [];
  const hasUnique = constraints.length > 0;

  return {
    ok: missingColumns.length === 0 && hasUnique,
    columns: [...columns],
    missingColumns,
    uniqueConstraints: constraints.map((row) => row.conname),
    rowsVisible: Array.isArray(data) ? data.length : 0,
    detail: hasUnique
      ? undefined
      : "No UNIQUE constraint found on media_content — upsert onConflict='external_id' would fail. Re-run the migration.",
  };
}

async function main() {
  const { dryRun, file } = parseArgs();
  const description = env.describeEnv();

  console.log("Cinebroad — apply Supabase migrations");
  console.log("=".repeat(58));
  console.log(`Project ref : ${description.supabaseProjectRef}`);
  console.log(`Project URL : ${description.supabaseUrl}`);
  console.log(`Token       : ${description.supabaseAccessToken}`);
  console.log("=".repeat(58));

  const files = file ? [file] : listMigrationFiles();
  if (!files.length) {
    console.error(`No .sql files found in ${path.relative(ROOT_DIR, MIGRATIONS_DIR)}`);
    process.exitCode = 1;
    return;
  }
  files.forEach((entry) => console.log(`  • ${path.relative(ROOT_DIR, entry)}`));

  if (dryRun) {
    console.log("\n--dry-run — nothing was sent to Supabase.");
    files.forEach((entry) => {
      const sql = fs.readFileSync(entry, "utf8");
      console.log(`\n[${path.basename(entry)}] ${sql.length} chars, ${sql.split("\n").length} lines`);
    });
    process.exitCode = 0;
    return;
  }

  if (!env.canApplyMigrations()) {
    console.error("\nCannot apply automatically — SUPABASE_ACCESS_TOKEN is not set.");
    console.error("Do ONE of the following:\n");
    console.error("  A) Automated (recommended)");
    console.error("     1. Create a token: https://supabase.com/dashboard/account/tokens");
    console.error("     2. Add to .env:  SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxx");
    console.error("     3. Re-run:       npm run db:migrate\n");
    console.error("  B) Dashboard (no token needed)");
    console.error("     Supabase Dashboard → SQL Editor → paste the contents of");
    console.error(`     ${path.relative(ROOT_DIR, files[0])} → Run\n`);
    console.error("  C) Supabase CLI");
    console.error("     npx supabase init && npx supabase login");
    console.error(`     npx supabase link --project-ref ${description.supabaseProjectRef}`);
    console.error("     npx supabase db push\n");
    console.error("After A, B or C run:  npm run verify:supabase");
    process.exitCode = 1;
    return;
  }

  for (const entry of files) {
    const sql = fs.readFileSync(entry, "utf8");
    const name = path.relative(ROOT_DIR, entry);
    process.stdout.write(`\nApplying ${name} … `);
    const result = await runQuery(sql);

    if (!result.ok) {
      console.log("FAILED");
      console.error(`  ${explainApiFailure(result)}`);
      process.exitCode = 1;
      return;
    }
    console.log("done");
  }

  console.log("\nVerifying the schema …");
  const verification = await verifyTable();
  if (verification.ok) {
    console.log(`✓ ${TABLE} is ready (${verification.uniqueConstraints.join(", ")})`);
    console.log(`  visible via PostgREST, ${verification.rowsVisible} row(s) so far.`);
    console.log("\nNext: npm run verify:supabase");
    console.log("      npm run server");
    process.exitCode = 0;
    return;
  }

  console.error(`✗ Verification failed: ${verification.detail || verification.reason || "unknown reason"}`);
  if (verification.missingColumns?.length) {
    console.error(`  Missing columns: ${verification.missingColumns.join(", ")}`);
  }
  console.error("\nIf PostgREST has not picked up the new table yet, wait ~10s and re-run,");
  console.error("or reload the schema cache in Dashboard → Settings → API.");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("\nFatal error:", error.message);
  process.exitCode = 1;
});