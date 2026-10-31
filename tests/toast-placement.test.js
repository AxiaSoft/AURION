/**
 * Notifications sit at the top centre of the window, on a desk and on a
 * phone alike - where the operating system puts them.
 *
 * They used to be a stack in the bottom-right corner, with a separate
 * full-width placement for phones and a body class that lifted them
 * off the settings sheet's bottom bar.
 *
 * Two details here are the whole reason this is a test and not a
 * glance at the stylesheet:
 *
 *   - the strip has to span the window to centre a banner in it, which
 *     lays an invisible fixed bar across the header. Without
 *     pointer-events:none on the strip and auto on the banner, every
 *     click on the header is swallowed by a container holding nothing.
 *   - it must come out on top without a large z-index. #toasts is a
 *     child of <body> and #app is `position:relative; z-index:1`, so
 *     50 is already above the header's 90 and the drawer's 210 - they
 *     are not in the same stacking context. A test that simply read
 *     the numbers would conclude the opposite.
 *
 *     node tests/toast-placement.test.js
 */

const fs=require("node:fs"),path=require("node:path");
let jsdom=null;
try{jsdom=require(require.resolve("jsdom"));}catch{/* optional */}
if(!jsdom){console.log("SKIP  toast placement (jsdom not installed)");process.exit(0);}
const {JSDOM}=jsdom;
const ROOT=path.resolve(__dirname,"..");
const WEB=path.join(ROOT,"apps","web");
const FILES=["css/app.css","css/skins.css","css/chart.css","css/themes.css"];
const css=FILES.map(f=>fs.readFileSync(path.join(WEB,f),"utf8"));
const STATE=/:(focus-visible|focus-within|focus|hover|active)(?![-\w])/g;
function spec(sel){const s=sel.replace(/\*/g," ");
 const id=(s.match(/#[-\w]+/g)||[]).length;
 const cl=(s.match(/\.[-\w]+|\[[^\]]+\]|:(?!:)[-\w]+(\([^)]*\))?/g)||[]).length;
 const el=(s.match(/(^|[\s>+~(])[a-zA-Z][-\w]*/g)||[]).length;
 return id*10000+cl*100+el;}
function build(){
 const d=new JSDOM(`<!doctype html><html data-skin="aurora" data-theme="dark" data-glass="on" data-perf="rich"><head>`+
  css.map((c,i)=>`<style data-src="${FILES[i]}">${c}</style>`).join("")+
  `</head><body><div id="app"><section id="desk"><header class="top"></header></section></div>
   <div class="toast-wrap" id="toasts"><div class="toast"><span class="toast-msg">x</span><button class="n-x" data-nx="toast"></button></div></div>
   </body></html>`).window.document;
 const flat=[];let o=0;
 for(const sh of d.styleSheets){const src=(sh.ownerNode&&sh.ownerNode.getAttribute("data-src"))||"?";
  const walk=(L,mq)=>{for(const r of L){ if(r.cssRules&&r.conditionText!==undefined){walk(r.cssRules,(mq?mq+" and ":"")+r.conditionText);continue;}
   if(!r.selectorText)continue; flat.push({src,mq,sel:r.selectorText,style:r.style,order:o++});}};
  try{walk(sh.cssRules,"");}catch(e){}}
 return {d,flat};
}
const {d,flat}=build();
function win(el,prop,W){
 const c=[];
 for(const r of flat){const v=r.style.getPropertyValue(prop);if(!v)continue;
  if(r.mq){if(/prefers-reduced-motion|forced-colors|print/.test(r.mq))continue;
   const mx=/max-width:\s*(\d+)px/.exec(r.mq),mn=/min-width:\s*(\d+)px/.exec(r.mq);
   if(mx&&W>Number(mx[1]))continue; if(mn&&W<Number(mn[1]))continue;}
  for(const raw of r.sel.split(",")){const s=raw.trim();
   const st=(s.match(STATE)||[]).join(""); if(/hover|active|focus/.test(st))continue;
   let b=s.replace(STATE,"").replace(/(^|[\s>+~])(?=$|[\s>+~])/g,"$1*").trim()||"*";
   let m=false;try{m=el.matches(b);}catch(e){continue;} if(!m)continue;
   c.push({sp:spec(s),order:r.order,sel:s,v});break;}}
 if(!c.length)return null;
 c.sort((a,b)=>(a.sp-b.sp)||(a.order-b.order));
 return c[c.length-1];
}
const results=[];
const say=(ok,m)=>{results.push(Boolean(ok));console.log((ok?"PASS  ":"FAIL  ")+m);};
const wrap=d.querySelector(".toast-wrap"), toast=d.querySelector(".toast");
for(const [label,W] of [["desktop",1440],["phone",390]]){
 console.log(`\n=== ${label} ===`);
 const top=win(wrap,"inset-block-start",W), bot=win(wrap,"inset-block-end",W);
 const ins=win(wrap,"inset-inline",W), just=win(wrap,"justify-items",W);
 const pe=win(wrap,"pointer-events",W), tpe=win(toast,"pointer-events",W);
 say(top&&/safe-t/.test(top.v), `anchored to the top edge: ${top&&top.v}`);
 say(!bot, `no bottom anchor left (${bot?bot.v+" <= "+bot.sel:"none"})`);
 say(ins&&ins.v.trim()==="0", `spans the width so it can centre: inset-inline ${ins&&ins.v}`);
 say(just&&just.v.trim()==="center", `centred: ${just&&just.v}`);
 say(pe&&pe.v.trim()==="none", `the strip does not eat clicks on the header: ${pe&&pe.v}`);
 say(tpe&&tpe.v.trim()==="auto", `but the banner itself does: ${tpe&&tpe.v}`);
}
const app=fs.readFileSync(path.join(WEB,"css/app.css"),"utf8");
const kf=/@keyframes toastIn\{from\{[^}]*translateY\((-?[\d.]+)px\)/.exec(app);
say(kf&&Number(kf[1])<0, `it falls from above: translateY(${kf&&kf[1]}px)`);
say(!/has-set-bar/.test(app), "the bottom-bar dodge is gone from the css");
say(!/has-set-bar/.test(fs.readFileSync(path.join(WEB,"js/app.js"),"utf8")), "and from the js");
const bad=results.filter(r=>!r).length;
console.log("\ntoast-placement: "+(bad?bad+" FAILED of "+results.length:results.length+" checks passed"));
process.exit(bad?1:0);
