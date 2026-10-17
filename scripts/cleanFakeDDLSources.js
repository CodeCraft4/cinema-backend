#!/usr/bin/env node
"use strict";

/**
 * Permanently delete media_sources rows whose source_type is ddl.
 * Torrent and embed_stream rows are not selected and are not deleted.
 *
 *   npm run clean:ddl
 */

const { createClient } = require("@supabase/supabase-js");
const env = require("../server/config/env");

const TABLE = "media_sources";

function readEnv(name) {
  const value = process.env[name];
  if (value == null) return "";
  return String(value).trim().replace(/^['"]|['"]$/g, "");
}

function resolveCredentials() {
  const url = readEnv("SUPABASE_URL") || env.supabaseUrl;
  const serviceKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = readEnv("SUPABASE_ANON_KEY");
  if (serviceKey) return { url, key: serviceKey, keySource: "SUPABASE_SERVICE_ROLE_KEY" };
  if (anonKey) return { url, key: anonKey, keySource: "SUPABASE_ANON_KEY" };
  return { url, key: env.supabaseKey, keySource: env.supabaseKeySource || "project env" };
}

async function countByType(supabase, sourceType) {
  const { count, error } = await supabase
    .from(TABLE)
    .select("id", { count: "exact", head: true })
    .eq("source_type", sourceType);
  if (error) throw new Error(error.message);
  return count || 0;
}

async function main() {
  const { url, key, keySource } = resolveCredentials();
  if (!url || !key) {
    console.error("Supabase credentials are missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    process.exitCode = 1;
    return;
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  console.log("Cinebroad — delete media_sources where source_type = ddl");
  console.log(`Key source : ${keySource}`);

  const before = {
    ddl: await countByType(supabase, "ddl"),
    torrent: await countByType(supabase, "torrent"),
    embed_stream: await countByType(supabase, "embed_stream"),
  };
  console.log(`Before     : ddl ${before.ddl}, torrent ${before.torrent}, embed_stream ${before.embed_stream}`);

  const { error, count } = await supabase.from(TABLE).delete({ count: "exact" }).eq("source_type", "ddl");
  if (error) throw new Error(error.message);

  const after = {
    ddl: await countByType(supabase, "ddl"),
    torrent: await countByType(supabase, "torrent"),
    embed_stream: await countByType(supabase, "embed_stream"),
  };
  const deleted = Number.isFinite(count) ? count : before.ddl - after.ddl;

  if (after.torrent !== before.torrent || after.embed_stream !== before.embed_stream) {
    throw new Error("torrent or embed_stream row count changed; expected those rows to stay.");
  }

  console.log(`Deleted    : ${deleted} ddl row(s)`);
  console.log(`After      : ddl ${after.ddl}, torrent ${after.torrent}, embed_stream ${after.embed_stream}`);
}

main().catch((error) => {
  console.error(`Clean-up failed: ${error.message}`);
  process.exitCode = 1;
});
