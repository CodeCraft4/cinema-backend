const fs=require("fs");
const net=require("net");
const Tracker=require("torrent-stream/node_modules/bittorrent-tracker/client");
const parse=require("parse-torrent-file");

const ih=process.argv[2].toLowerCase();
const urls=JSON.parse(fs.readFileSync(".torrent_cache/announce_fail.json","utf8"));
const peerId="-TS0008-abcdefghijklmnopqrst";
const port=6881;

function tcpTest(ip,p,timeout=7000){
  return new Promise((res)=>{
    const c=net.connect({host:ip,port:p});
    const t=setTimeout(()=>{c.destroy();res({ip,p,r:"TIMEOUT"})},timeout);
    c.on("connect",()=>{clearTimeout(t);c.destroy();res({ip,p,r:"CONNECTED"})});
    c.on("error",e=>{clearTimeout(t);res({ip,p,r:"ERR "+e.code})});
  });
}

const peers=new Map();
const client=new Tracker(peerId,port,{infoHash:ih,announce:urls,length:0},{});
client.on("peer",(addr)=>{ peers.set(addr,addr); });
client.on("warning",(e)=>console.log("WARN",e.message));
client.on("error",(e)=>console.log("ERR",e.message));
client.start();

setTimeout(async()=>{
  console.log("peers discovered:",peers.size);
  const list=[...peers.keys()];
  const res=await Promise.all(list.map(a=>{const i=a.lastIndexOf(":");return tcpTest(a.slice(0,i),Number(a.slice(i+1)))}));
  let ok=0;
  for(const r of res){ if(r.r==="CONNECTED")ok++; console.log(r.ip+":"+r.p,"->",r.r); }
  console.log("connected",ok,"/",res.length);
  process.exit(0);
},25000);
