/**
 * One update check, for the whole desk.
 *
 * There were two, against two different servers. The licence box in
 * Settings > System asked the engine for a GitHub releases lookup,
 * which reads `license.github_repo` from the config. A customer's
 * machine does not set that key, so the engine answered
 * {configured:false} and the desk printed "You are on the latest
 * published build" beside it - a clean bill of health for a check that
 * never happened. Even configured it compares a public release tag,
 * which is not the channel the product updates from.
 *
 * The real one is /api/system/update/check, behind the Update section,
 * and it is the only one that can produce a changelog, a file
 * manifest, a backup and an install.
 *
 * This drives all three buttons against a stubbed backend and asserts
 * where each one goes and what it then says - which is the only way to
 * see it, since both versions looked equally plausible in the source.
 *
 *     node tests/update-check.test.js
 */

const fs=require("node:fs"),path=require("node:path");
let jsdom=null;
try{jsdom=require(require.resolve("jsdom"));}catch{/* optional */}
if(!jsdom){console.log("SKIP  update check (jsdom not installed)");process.exit(0);}
const {JSDOM,VirtualConsole}=jsdom;
const ROOT=path.resolve(__dirname,"..");
const WEB=path.join(ROOT,"apps","web");
const read=p=>fs.readFileSync(path.join(WEB,p),"utf8");
const results=[];
function say(ok,m){results.push(Boolean(ok));console.log((ok?"PASS  ":"FAIL  ")+m);}

function boot(reply){
 const dom=new JSDOM(read("index.html"),{url:"http://localhost/",runScripts:"outside-only",pretendToBeVisual:true,virtualConsole:new VirtualConsole()});
 const win=dom.window,doc=win.document;
 const calls=[];
 win.fetch=async()=>({ok:true,json:async()=>({ok:true,data:{}})});
 win.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
 win.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
 win.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 win.URL.createObjectURL=()=>"blob:x";
 win.AudioContext=class{createGain(){return{connect(){},gain:{}}}};
 win.HTMLCanvasElement.prototype.getContext=()=>null;
 win.confirm=()=>false;
 const bundle=["js/themes.js","js/skins.js","js/i18n.js","js/api.js","js/calendar.js","js/chart-series.js","js/charts.js","js/chart-tools.js","js/pnl-charts.js","js/app.js"].map(read).join("\n;\n");
 win.eval(bundle+"\n;window.__T={S,views,I18N,bindView,API,showSetTab,checkForUpdate};");
 const T=win.__T;
 T.I18N.pack=JSON.parse(fs.readFileSync(path.join(ROOT,"lang","en.json"),"utf8"));
 T.API.get=async(u)=>{calls.push("GET "+u);return{ok:true,data:{}};};
 T.API.post=async(u,b)=>{calls.push("POST "+u);return u.includes("update/check")?reply:{ok:true,data:{}};};
 T.S.version="1.0.0";
 return {win,doc,T,calls,stage:doc.getElementById("stage")};
}
const UPTODATE={ok:true,update_available:false,latest:{version:"1.0.0"},last_check:"2026-01-01"};
const AVAIL={ok:true,update_available:true,latest:{version:"1.4.0",id:"u1",files:[],changelog:"x"},last_check:"2026-01-01"};
const tick=()=>new Promise(r=>setTimeout(r,0));

(async()=>{
 console.log("=== all three go to the real updater, not the GitHub lookup ===");
 for (const [where,view,tab,btnId,outId] of [
   ["the licence box","settings","set-system","lic-upd","lic-upd-msg"],
   ["the Update section","settings","set-update","upd-check","upd-result"],
   ["the About page","about",null,"about-check-update","about-update-status"],
 ]){
  const k=boot(UPTODATE);
  k.stage.innerHTML=k.T.views[view](); k.T.bindView(view);
  if(tab) k.T.showSetTab(tab);
  for(let i=0;i<10;i++) await tick();   // bindUpdatePanel awaits two requests first
  k.calls.length=0;
  const b=k.doc.getElementById(btnId);
  if(!b){say(false,where+": no "+btnId);continue;}
  b.click(); for(let i=0;i<10;i++) await tick();
  const posts=k.calls.filter(c=>c.startsWith("POST"));
  say(k.calls.some(c=>c==="POST /api/system/update/check"), `${where.padEnd(20)} -> ${k.calls.join(", ")||"(nothing)"}`);
  say(!k.calls.some(c=>c.includes("/api/updates")), `${where.padEnd(20)} does not use the GitHub channel`);
  const out=k.doc.getElementById(outId);
  const txt=out?out.textContent.trim():"";
  say(/Up to date/i.test(txt), `${where.padEnd(20)} says: "${txt}"`);
 }

 console.log("\n=== when there IS one, the licence box hands over ===");
 {
  const k=boot(AVAIL);
  k.stage.innerHTML=k.T.views.settings(); k.T.bindView("settings"); k.T.showSetTab("set-system");
  k.doc.getElementById("lic-upd").click(); await tick(); await tick();
  const msg=k.doc.getElementById("lic-upd-msg");
  say(/Update available/i.test(msg.textContent), `reports it: "${msg.textContent.trim()}"`);
  const go=k.doc.getElementById("lic-upd-go");
  say(Boolean(go), "offers a way through to the section that can install it");
  if(go){ go.click(); await tick();
   const shown=k.doc.querySelector(".set-block:not([hidden])");
   say(shown&&shown.id==="set-update", "and it opens the Update section ("+(shown&&shown.id)+")"); }
 }

 console.log("\n=== an error is an error, not a clean bill of health ===");
 {
  const k=boot({ok:false,error:"update server unreachable"});
  k.stage.innerHTML=k.T.views.settings(); k.T.bindView("settings"); k.T.showSetTab("set-system");
  k.doc.getElementById("lic-upd").click(); await tick(); await tick();
  const t=k.doc.getElementById("lic-upd-msg").textContent;
  say(/unreachable/.test(t) && !/latest|Up to date/i.test(t), `reports the failure: "${t.trim()}"`);
 }
 const js=read("js/app.js");
 say(!/API\.get\("\/api\/updates"\)/.test(js), "the GitHub releases call is gone from the desk");
 say((js.match(/API\.post\("\/api\/system\/update\/check"/g)||[]).length===1, "the check is written exactly once");
 const bad=results.filter(r=>!r).length;
 console.log("\nupdate-check: "+(bad?bad+" FAILED of "+results.length:results.length+" checks passed"));
 process.exit(bad?1:0);
})();
