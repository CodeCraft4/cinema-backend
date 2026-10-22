const dgram = require("dgram");
const crypto = require("crypto");
const net = require("net");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const TRACKERS = [
  ["tracker.opentrackr.org", 1337],
  ["open.stealth.si", 80],
  ["tracker.dler.org", 6969],
  ["tracker.torrent.eu.org", 451],
  ["explodie.org", 6969],
];

const HTTP_TRACKERS = [
  "http://tracker.opentrackr.org:1337/announce",
  "http://tracker.openbittorrent.com:80/announce",
  "http://tracker.dler.org:6969/announce",
  "http://bt.okmp3.ru:2710/announce",
  "http://tracker.torrent.eu.org:451/announce",
  "http://explodie.org:6969/announce",
];

function httpProbe(url, ih) {
  return new Promise((res) => {
    const u = new URL(url);
    const peerId = "-TS0008-12345678901234567890";
    const q = new URLSearchParams({
      info_hash: Buffer.from(ih, "hex").toString("binary"),
      peer_id: peerId,
      port: "6881",
      uploaded: "0",
      downloaded: "0",
      left: "0",
      compact: "1",
      event: "started",
    });
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(`${u.origin}${u.pathname}?${q}`, { timeout: 9000 }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const body = Buffer.concat(chunks);
        const peers = [];
        if (body.length >= 20) {
          const compact = body.slice(20);
          for (let i = 0; i + 6 <= compact.length; i += 6) {
            peers.push({
              ip: Array.from(compact.slice(i, i + 4)).join("."),
              port: compact.readUInt16BE(i + 4),
            });
          }
        }
        res({ url, status: r.statusCode, peers });
      });
    });
    req.on("timeout", () => { req.destroy(); res({ url, err: "timeout" }); });
    req.on("error", (e) => res({ url, err: e.message }));
  });
}

function probe(host, port, ih) {
  return new Promise((res) => {
    const s = dgram.createSocket("udp4");
    const tid = crypto.randomBytes(4);
    const conn = Buffer.alloc(16);
    conn.writeBigUInt64BE(0x41727101980n, 0);
    conn.writeUInt32BE(0, 8);
    tid.copy(conn, 12);

    let stage = "connect";
    let cid = null;
    let done = false;

    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { s.close(); } catch (_) {}
      res(out);
    };

    s.on("error", (e) => finish({ host, port, err: e.message }));

    s.on("message", (m) => {
      if (stage === "connect") {
        if (m.length < 16) return finish({ host, port, err: "short handshake" });
        cid = m.slice(8, 16);
        stage = "announce";
        const t2 = crypto.randomBytes(4);
        const payload = Buffer.alloc(82);
        Buffer.from(ih, "hex").copy(payload, 0);
        Buffer.from("-TS0008-12345678901234567890").copy(payload, 20);
        payload.writeUInt32BE(0, 40);
        payload.writeUInt32BE(0, 44);
        payload.writeUInt32BE(0, 48);
        payload.writeUInt32BE(0, 52);
        payload.writeUInt32BE(0, 56);
        payload.writeUInt32BE(2, 64);
        payload.writeUInt32BE(0, 68);
        payload.writeUInt32BE(0, 72);
        payload.writeUInt32BE(100, 76);
        payload.writeUInt16BE(6881, 80);
        const buf = Buffer.concat([cid, Buffer.from([0, 0, 0, 1]), t2, payload]);
        s.send(buf, 0, buf.length, port, host, (e2) => {
          if (e2) finish({ host, port, err: e2.message });
        });
        return;
      }

      if (stage === "announce") {
        const body = m.slice(20);
        const peers = [];
        for (let i = 0; i + 6 <= body.length; i += 6) {
          peers.push({
            ip: Array.from(body.slice(i, i + 4)).join("."),
            port: body.readUInt16BE(i + 4),
          });
        }
        finish({ host, port, complete: m.readUInt32BE(16), incomplete: m.readUInt32BE(12), peers });
      }
    });

    const timer = setTimeout(() => finish({ host, port, err: "timeout at stage " + stage }), 9000);
    s.send(conn, 0, 16, port, host, (e) => {
      if (e) finish({ host, port, err: e.message });
    });
  });
}

function tcpTest(ip, port, timeout = 8000) {
  return new Promise((res) => {
    const t0 = Date.now();
    const c = net.connect({ host: ip, port });
    const timer = setTimeout(() => {
      c.destroy();
      res({ ip, port, result: "TIMEOUT" });
    }, timeout);
    c.on("connect", () => {
      clearTimeout(timer);
      c.destroy();
      res({ ip, port, result: "CONNECTED " + (Date.now() - t0) + "ms" });
    });
    c.on("error", (e) => {
      clearTimeout(timer);
      res({ ip, port, result: "ERR " + e.code });
    });
  });
}

(async () => {
  const ih = process.argv[2];
  if (!ih) {
    console.error("usage: node scripts/_probe_peers.js <infohashhex>");
    process.exit(1);
  }
  console.log("infoHash:", ih);
  const all = new Map();
  for (const [h, p] of TRACKERS) {
    const r = await probe(h, p, ih);
    if (r.err) {
      console.log(h + ":" + p, "ERR", r.err);
      continue;
    }
    console.log(h + ":" + p, "complete=" + r.complete, "incomplete=" + r.incomplete, "peers=" + r.peers.length);
    for (const peer of r.peers) {
      all.set(peer.ip + ":" + peer.port, peer);
    }
  }
  const list = [...all.values()];
  console.log("\n=== unique UDP peers:", list.length, "===");
  const results = await Promise.all(list.map((x) => tcpTest(x.ip, x.port)));
  for (const r of results) console.log(r.ip + ":" + r.port, "->", r.result);

  console.log("\n=== HTTP trackers ===");
  for (const t of HTTP_TRACKERS) {
    const r = await httpProbe(t, ih);
    if (r.err) {
      console.log(t, "ERR", r.err);
      continue;
    }
    console.log(t, "status=" + r.status, "peers=" + r.peers.length);
    for (const peer of r.peers) {
      const tr = await tcpTest(peer.ip, peer.port, 6000);
      console.log("   ", peer.ip + ":" + peer.port, "->", tr.result);
    }
  }
  process.exit(0);
})();

