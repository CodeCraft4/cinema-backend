const fs = require("fs");
const path = require("path");
const torrentStream = require("torrent-stream");

const file = process.argv[2];
const buf = fs.readFileSync(file);
const storagePath = path.join(process.cwd(), ".torrent_cache", "probe_ub");
fs.mkdirSync(storagePath, { recursive: true });

const t0 = Date.now();
const engine = torrentStream(buf, {
  connections: 35,
  uploads: 2,
  path: storagePath,
  trackers: ["udp://tracker.opentrackr.org:1337/announce", "udp://tracker.openbittorrent.com:6969/announce"],
  verify: false,
  dht: true,
});

console.log("swarm.peerId length:", engine.swarm.peerId.length);

let peerEvents = 0;
const wireAddrs = new Set();
engine.on("peer", (addr) => { peerEvents++; console.log(`[${Date.now() - t0}ms] PEER-EVENT`, addr); });
engine.on("wire", (wire) => {
  wireAddrs.add(wire.peerAddress);
  console.log(`[${Date.now() - t0}ms] WIRE`, wire.peerAddress, "peerChoking=", wire.peerChoking, "pieces=", (wire.peerPieces || []).length);
});
engine.on("error", (e) => console.log(`[${Date.now() - t0}ms] ERROR`, e.message));
engine.on("ready", () => console.log(`[${Date.now() - t0}ms] READY files=`, (engine.files || []).map((f) => f.name).join(",")));
engine.on("download", () => console.log(`[${Date.now() - t0}ms] DOWNLOAD piece`));

const iv = setInterval(() => {
  const wires = (engine.swarm && engine.swarm.wires) || [];
  console.log(`[${Date.now() - t0}ms] STAT peerEvents=${peerEvents} wires=${wires.length} conns=${(engine.swarm.connections || []).length} downloaded=${engine.swarm.downloaded}`);
}, 5000);

setTimeout(() => {
  clearInterval(iv);
  const wires = (engine.swarm && engine.swarm.wires) || [];
  console.log("=== FINAL === peerEvents:", peerEvents, "wires:", wires.length);
  console.log("wire addrs:", [...wireAddrs].join(", "));
  console.log("isSeeder present:", wires.map((w) => String(w.isSeeder)).join(","));
  try { engine.destroy(); } catch (e) {}
  process.exit(0);
}, 40000);
