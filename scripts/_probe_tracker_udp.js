const dgram = require("dgram");
const crypto = require("crypto");

const TRACKERS = [
  ["tracker.opentrackr.org", 1337],
  ["open.stealth.si", 80],
  ["tracker.dler.org", 6969],
  ["tracker.torrent.eu.org", 451],
  ["explodie.org", 6969],
  ["tracker.openbittorrent.com", 6969],
];

function probe(host, port, ih) {
  return new Promise((res) => {
    const s = dgram.createSocket("udp4");
    const tid = crypto.randomBytes(4);
    const conn = Buffer.alloc(16);
    conn.writeBigUInt64BE(0x41727101980n, 0); // connection id (8)
    conn.writeUInt32BE(0, 8); // action = connect (4)
    tid.copy(conn, 12); // transaction id (4)

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
        Buffer.from(ih, "hex").copy(payload, 0); // info_hash 20
        Buffer.from("-TS0008-12345678901234567890").copy(payload, 20); // peer_id 20
        payload.writeUInt32BE(0, 40); // downloaded
        payload.writeUInt32BE(0, 44);
        payload.writeUInt32BE(0, 48); // left
        payload.writeUInt32BE(0, 52);
        payload.writeUInt32BE(0, 56); // uploaded
        payload.writeUInt32BE(0, 60);
        payload.writeUInt32BE(2, 64); // event = started
        payload.writeUInt32BE(0, 68); // ip
        payload.writeUInt32BE(0, 72); // key
        payload.writeUInt32BE(100, 76); // num_want
        payload.writeUInt16BE(6881, 80); // port
        const buf = Buffer.concat([cid, Buffer.from([0, 0, 0, 1]), t2, payload]);
        s.send(buf, 0, buf.length, port, host, (e2) => {
          if (e2) finish({ host, port, err: e2.message });
        });
        return;
      }

      if (stage === "announce") {
        finish({
          host, port,
          len: m.length,
          action: m.readUInt32BE(0),
          interval: m.readUInt32BE(8),
          incomplete: m.readUInt32BE(12),
          complete: m.readUInt32BE(16),
          peerBytes: m.length - 20,
          nPeers: (m.length - 20) / 6,
          hex: m.slice(20).toString("hex"),
        });
      }
    });

    const timer = setTimeout(() => finish({ host, port, err: "timeout at stage " + stage }), 9000);
    s.send(conn, 0, 16, port, host, (e) => {
      if (e) finish({ host, port, err: e.message });
    });
  });
}

(async () => {
  const ih = process.argv[2] || "b16a13a4d1d4e2b0e0dd0d0e8e1a1b6c1b8f4b0d1";
  console.log("infoHash:", ih);
  for (const [h, p] of TRACKERS) {
    console.log(JSON.stringify(await probe(h, p, ih)));
  }
  process.exit(0);
})();

