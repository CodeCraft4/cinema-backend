"use strict";

/**
 * Bootstrap for the media caching service.
 *   npm run server            → http://localhost:4555
 *   GET /api/tv-shows/health  ← start here to confirm Supabase connectivity
 */

// Ensure global WebSocket exists for @supabase/supabase-js in all environments
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = class WebSocketPolyfill {
    constructor() {
      this.readyState = 0;
    }
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  };
}

const app = require("./app");
const env = require("./config/env");
const { checkSupabaseConnection } = require("./services/supabaseClient");

async function start() {
  const description = env.describeEnv();
  console.log("── Cinebroad media service ────────────────────────────");
  console.log(`   Supabase URL  : ${description.supabaseUrl}  (${description.supabaseUrlSource})`);
  console.log(`   Supabase key  : ${description.supabaseKey}  (${description.supabaseKeySource}, role=${description.supabaseKeyRole})`);
  console.log(`   TVMaze base   : ${description.tvmazeBaseUrl}`);
  console.log(`   Cache TTL     : ${Math.round(description.cacheTtlMs / 3600000)}h`);
  description.envWarnings.forEach((warning) => console.warn(`   ! ${warning}`));
  console.log("───────────────────────────────────────────────────────");

  if (!env.isSupabaseConfigured()) {
    console.error("! Supabase credentials could not be resolved — API calls will fail until .env is fixed.");
  } else {
    const db = await checkSupabaseConnection();
    if (db.tableReady) console.log(`✓ Supabase reachable — media_content has ${db.rowCount} cached row(s).`);
    else console.error(`! Supabase reachable but the cache is not ready: ${db.error?.message || "unknown error"}`);
  }

  const server = app.listen(env.port, () => {
    console.log(`✓ Listening on http://localhost:${env.port}`);
  });

  // Support unlimited file sizes (1GB to 5GB+) without dropping connection after 500MB
  server.timeout = 0;
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  if ("requestTimeout" in server) {
    server.requestTimeout = 0;
  }

  const shutdown = (signal) => {
    console.log(`\n${signal} received — closing the server…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((error) => {
  console.error("Fatal startup error:", error.message);
  process.exit(1);
});