/**
 * Background images.
 *
 * AURION ships twenty photographs in apps/web/assets/bg - a dark and a light
 * cut of ten scenes - and every one of them used to be nailed to the theme
 * of the same name in css/themes.css. The only way to see the ocean picture
 * was to use the Ocean theme. The request was to be able to choose any of
 * them, on any theme; what had been built instead was a gallery of drawn
 * gradients and effects, which is a different thing entirely.
 *
 * These checks pin the library down: that every file on disk is offered,
 * that every tile points at a file that exists, that the choice is per
 * theme, that the dark/light cut follows the mode, and that a bad name
 * cannot reach the stylesheet.
 */
const fs=require("fs"),path=require("path");
const {JSDOM}=require(require.resolve("jsdom"));
const WEB=path.join(__dirname,"..","apps","web");
const dom=new JSDOM(`<!doctype html><html><head></head><body></body></html>`,{url:"http://localhost/",runScripts:"outside-only"});
const win=dom.window;
const store={};
Object.defineProperty(win,"localStorage",{value:{getItem:k=>k in store?store[k]:null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}},configurable:true});
win.eval(fs.readFileSync(path.join(WEB,"js/themes.js"),"utf8"));
const T=win.AurionTheme, el=win.document.documentElement;
const css=()=>{const s=win.document.getElementById("aurion-theme-knobs");return s?s.textContent:""};
let f=0;const ok=(c,m,d)=>{if(!c){f++;console.log("FAIL "+m+(d?"  — "+d:""))}else console.log("ok   "+m+(d?"  — "+d:""))};

/* Most themes are premium, and set() silently refuses a locked one - which
   would leave every edit below landing on the default theme and quietly
   testing nothing. Unlock first. */
T.setPaid(true);
ok(T.effective()!=="","the harness has a theme to work on");

ok(Array.isArray(T.WALLPAPERS)&&T.WALLPAPERS.length===10,"ten wallpapers are offered",String(T.WALLPAPERS.length));
// every advertised file must exist on disk, in both cuts
const missing=[];
T.WALLPAPERS.forEach(w=>["dark","light"].forEach(c=>{
  const p=path.join(WEB,"assets","bg",`${w}-${c}.jpg`);
  if(!fs.existsSync(p))missing.push(`${w}-${c}.jpg`);
}));
ok(!missing.length,"every tile points at a file that exists",missing.join(", ")||"all 20 present");

// and nothing on disk is left out of the gallery
const onDisk=fs.readdirSync(path.join(WEB,"assets","bg")).filter(x=>x.endsWith(".jpg"));
const stems=[...new Set(onDisk.map(x=>x.replace(/-(dark|light)\.jpg$/,"")))].sort();
ok(JSON.stringify(stems)===JSON.stringify([...T.WALLPAPERS].sort()),
  "every picture shipped is in the gallery — none left stranded",
  stems.filter(x=>T.WALLPAPERS.indexOf(x)===-1).join(", ")||"none missing");

T.set("midnight");
ok(T.wall("midnight")==="","a theme starts on its own picture");
ok(!/--theme-bg/.test(css()),"and publishes no override");

// pick the ocean picture while on midnight — the whole point of the request
T.edit({wall:"ocean"});
ok(T.wall("midnight")==="ocean","any theme can wear any picture");
/* The published URL is absolute now. themes.css addresses the pictures as
   "../assets/bg/x.jpg" - resolved against the stylesheet - while an injected
   <style> resolves against the document, and those two bases only agree
   while the desk sits at the root. The backend answers every unmatched path
   with index.html, so on any other path the relative form would have
   resolved to HTML instead of a JPEG and the wallpaper would have silently
   failed to paint. Both routes are pinned to the same file now. */
ok(/--theme-bg:url\("[^"]*\/assets\/bg\/ocean-dark\.jpg"\)/.test(css()),
  "the dark cut is published for a dark desk",(css().match(/--theme-bg:[^}]*/)||[""])[0]);
ok(!/\.\.\/assets/.test(css()),
  "the published path never leans on the stylesheet's folder");

// flip to light: the cut must follow
el.dataset.theme="light";
T.apply();
ok(/ocean-light\.jpg/.test(css()),"a light desk gets the light cut",(css().match(/--theme-bg:[^}]*/)||[""])[0]);
el.dataset.theme="dark";T.apply();

// per theme, as asked
T.set("frost");
ok(T.wall("frost")==="","the choice belongs to the theme it was made on");
T.edit({wall:"sunset"});
T.set("midnight");
ok(T.wall("midnight")==="ocean","midnight still has its own");
T.set("frost");
ok(T.wall("frost")==="sunset","frost has a different one");

// explicitly no picture
T.edit({wall:"none"});
ok(T.wall("frost")==="none","'no picture' is remembered");
ok(/--theme-bg:none/.test(css()),"and actually clears the theme's own picture");

// back to the theme default
T.edit({wall:""});
ok(T.wall("frost")==="","clearing hands the theme back its own picture");
ok(!/--theme-bg/.test(css()),"and withdraws the override");

// junk must not get through
T.edit({wall:"../../etc/passwd"});
ok(T.wall("frost")==="","an unknown name is refused");
T.edit({wall:'ocean"); background:url(evil'});
ok(T.wall("frost")==="","an injection attempt is refused");

// survives a reload
T.edit({wall:"cyber"});
const saved=JSON.stringify(store);
win.eval(fs.readFileSync(path.join(WEB,"js/themes.js"),"utf8"));
ok(win.AurionTheme.wall("frost")==="cyber","the choice survives a restart");
void saved;

// the "theme's own" tile must show the THEME's picture, not the chosen one
T.set("midnight");
T.edit({wall:"ocean"});
ok(T.themeWall("midnight")==="midnight",
  "a theme's own picture is named after the theme, whatever is laid over it",T.themeWall("midnight"));
ok(T.themeWall("glass")==="" && T.themeWall("custom")==="",
  "themes that ship no picture say so rather than inventing a filename");

// the custom theme too
T.set("custom");
T.edit({wall:"mono"});
ok(T.wall("custom")==="mono","the custom theme can have one as well");

console.log(f?`\nwallpapers: ${f} FAILED`:"\nwallpapers: all checks passed");
process.exit(f?1:0);
