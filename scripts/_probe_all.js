const fs=require("fs");
const dgram=require("dgram");
const crypto=require("crypto");
const net=require("net");
const http=require("http");
const https=require("https");
const {URL}=require("url");

const ih=process.argv[2].toLowerCase();
const urls=JSON.parse(fs.readFileSync(".torrent_cache/announce_fail.json","utf8"));

function udpProbe(u){
  return new Promise((res)=>{
    const host=u.hostname, port=Number(u.port||80);
    const s=dgram.createSocket("udp4");
    const tid=crypto.randomBytes(4);
    const conn=Buffer.alloc(16);
    conn.writeBigUInt64BE(0x41727101980n,0);
    conn.writeUInt32BE(0,8);
    tid.copy(conn,12);
    let stage="connect", cid=null, done=false;
    const finish=(o)=>{ if(done)return; done=true; clearTimeout(timer); try{s.close()}catch(_){} res(o); };
    s.on("error",e=>finish({u,err:e.message}));
    s.on("message",m=>{
      if(stage==="connect"){
        if(m.length<16) return finish({u,err:"short"});
        cid=m.slice(8,16); stage="announce";
        const t2=crypto.randomBytes(4);
        const p=Buffer.alloc(82);
        Buffer.from(ih,"hex").copy(p,0);
        Buffer.from("-TS0008-12345678901234567890").copy(p,20);
        p.writeUInt32BE(0,40); p.writeUInt32BE(0,44); p.writeUInt32BE(0,48);
        p.writeUInt32BE(0,52); p.writeUInt32BE(0,56);
        p.writeUInt32BE(2,64); p.writeUInt32BE(0,68); p.writeUInt32BE(0,72);
        p.writeUInt32BE(100,76); p.writeUInt16BE(6881,80);
        const buf=Buffer.concat([cid,Buffer.from([0,0,0,1]),t2,p]);
        s.send(buf,0,buf.length,port,host,e=>{ if(e) finish({u,err:e.message}); });
        return;
      }
      const body=m.slice(20); const peers=[];
      for(let i=0;i+6<=body.length;i+=6) peers.push({ip:Array.from(body.slice(i,i+4)).join("."),port:body.readUInt16BE(i+4)});
      finish({u,complete:m.readUInt32BE(16),incomplete:m.readUInt32BE(12),peers});
    });
    const timer=setTimeout(()=>finish({u,err:"timeout"}),8000);
    s.send(conn,0,16,port,host,e=>{ if(e) finish({u,err:e.message}); });
  });
}

function httpProbe(u){
  return new Promise((res)=>{
    const peerId="-TS0008-12345678901234567890";
    const q=new URLSearchParams({info_hash:Buffer.from(ih,"hex").toString("binary"),peer_id:peerId,port:"6881",uploaded:"0",downloaded:"0",left:"0",compact:"1",event:"started",numwant:"100"});
    const lib=u.protocol==="https:"?https:http;
    const req=lib.get(`${u.origin}${u.pathname}?${q}`,{timeout:10000},r=>{
      const ch=[]; r.on("data",c=>ch.push(c));
      r.on("end",()=>{
        const body=Buffer.concat(ch); const peers=[];
        if(body.length>=20){const cm=body.slice(20);for(let i=0;i+6<=cm.length;i+=6)peers.push({ip:Array.from(cm.slice(i,i+4)).join("."),port:cm.readUInt16BE(i+4)});}
        res({u,status:r.statusCode,peers});
      });
    });
    req.on("timeout",()=>{req.destroy();res({u,err:"timeout"})});
    req.on("error",e=>res({u,err:e.message}));
  });
}

function tcpTest(ip,port,timeout=8000){
  return new Promise((res)=>{
    const c=net.connect({host:ip,port});
    const timer=setTimeout(()=>{c.destroy();res({ip,port,r:"TIMEOUT"})},timeout);
    c.on("connect",()=>{clearTimeout(timer);c.destroy();res({ip,port,r:"CONNECTED"})});
    c.on("error",e=>{clearTimeout(timer);res({ip,port,r:"ERR "+e.code})});
  });
}

(async()=>{
  const all=new Map();
  const tasks=urls.map(async(u)=>{
    const U=new URL(u);
    let r;
    if(U.protocol==="udp:") r=await udpProbe(U);
    else if(U.protocol==="http:"||U.protocol==="https:") r=await httpProbe(U);
    else return;
    if(r.err){console.log(u,"ERR",r.err);return;}
    console.log(u,"complete="+r.complete,"incomplete="+r.incomplete,"status="+(r.status||"-"),"peers="+r.peers.length);
    for(const p of r.peers) all.set(p.ip+":"+p.port,p);
  });
  await Promise.all(tasks);
  const list=[...all.values()];
  console.log("\n=== unique peers:",list.length,"===");
  const results=await Promise.all(list.map(x=>tcpTest(x.ip,x.port,7000)));
  let ok=0;
  for(const r of results){ if(r.r==="CONNECTED")ok++; console.log(r.ip+":"+r.port,"->",r.r); }
  console.log("connected:",ok,"/",results.length);
  process.exit(0);
})();
