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

ok(Array.isArray(T.WALLPAPERS)&&T.WALLPAPERS.length===11,"eleven wallpapers are offered",String(T.WALLPAPERS.length));
/* Resolve through wallUrl rather than rebuilding the filename here. Most
   pictures follow assets/bg/<name>-<cut>.jpg, but AURION's own backdrop is
   the orb the desk has always used, which lives beside the other artwork as
   a PNG. A test that reconstructs the pattern would demand a copy of a file
   that already exists somewhere else. */
const missing=[];
T.WALLPAPERS.forEach(w=>[["dark","night"],["light","day"]].forEach(([c,cut])=>{
  const url=T.wallUrl(`${w}@${cut}`, c==="light");
  if(!url){missing.push(`${w}@${cut} (no url)`);return}
  if(!fs.existsSync(path.join(WEB,url)))missing.push(url);
}));
ok(!missing.length,"every tile points at a file that exists",missing.join(", ")||"all 22 present");

// and nothing on disk is left out of the gallery
const onDisk=fs.readdirSync(path.join(WEB,"assets","bg")).filter(x=>x.endsWith(".jpg"));
const stems=[...new Set(onDisk.map(x=>x.replace(/-(dark|light)\.jpg$/,"")))].sort();
const stranded=stems.filter(x=>T.WALLPAPERS.indexOf(x)===-1);
ok(!stranded.length,
  "every picture shipped is in the gallery — none left stranded",
  stranded.join(", ")||"none missing");

T.set("midnight");
ok(T.wall("midnight")==="","a theme starts on its own picture");
ok(!/--theme-bg/.test(css()),"and publishes no override");

/* pick the ocean picture while on midnight — the whole point of the request

   REWRITTEN for a requested change of behaviour: an edit now moves the
   desk onto the Custom theme, seeded from whatever was on screen, so
   the choice lands on "custom" rather than on "midnight". The shipped
   themes stay as they shipped, which is the point - the gallery used
   to go on saying "midnight" while showing something midnight does not
   look like.

   What is being guarded is unchanged: any theme can be given any
   picture, and it is published. */
T.edit({wall:"ocean"});
ok(T.effective()==="custom","an edit moves the desk onto the custom theme",T.effective());
ok(T.wall("custom")==="ocean","any theme can wear any picture",T.wall("custom"));
ok(T.wall("midnight")==="","and the theme it came from is left as it shipped",T.wall("midnight"));
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

/* The shipped themes stay pristine.

   This block used to show the choice living on whichever theme was in
   use - frost holding sunset while midnight held ocean. Edits all land
   on Custom now, so what has to be proved is the other half of the
   same property: picking a picture while frost is on screen must not
   change frost. A built-in that quietly drifts is the bug the per-theme
   storage was introduced to fix, and it must not come back by a
   different route. */
T.set("frost");
ok(T.wall("frost")==="","a built-in starts on its own picture");
T.edit({wall:"sunset"});
ok(T.wall("custom")==="sunset","the pick lands on custom",T.wall("custom"));
ok(T.wall("frost")==="","and frost is untouched",T.wall("frost"));
ok(T.wall("midnight")==="","and so is midnight",T.wall("midnight"));

// explicitly no picture
T.edit({wall:"none"});
ok(T.wall("custom")==="none","'no picture' is remembered");
ok(/--theme-bg:none/.test(css()),"and actually clears the theme's own picture");

// back to the theme default
T.edit({wall:""});
ok(T.wall("custom")==="","clearing hands the theme back its own picture");
ok(!/--theme-bg/.test(css()),"and withdraws the override");

// junk must not get through
T.edit({wall:"../../etc/passwd"});
ok(T.wall("custom")==="","an unknown name is refused");
T.edit({wall:'ocean"); background:url(evil'});
ok(T.wall("custom")==="","an injection attempt is refused");

// survives a reload
T.edit({wall:"cyber"});
const saved=JSON.stringify(store);
win.eval(fs.readFileSync(path.join(WEB,"js/themes.js"),"utf8"));
ok(win.AurionTheme.wall("custom")==="cyber","the choice survives a restart",
  win.AurionTheme.wall("custom"));
void saved;

/* the "theme's own" tile must show the THEME's picture, not the chosen one.
   themeWall() is a lookup against the table, so it answers for a theme
   whether or not that theme is the one being edited. */
T.set("midnight");
T.edit({wall:"ocean"});
ok(T.themeWall("midnight")==="midnight",
  "a theme's own picture is named after the theme, whatever is laid over it",T.themeWall("midnight"));
/* The default theme is "glass" in storage and AURION on screen, and it does
   ship a picture - the orb. It was the one backdrop a trader could see and
   not find in the list. Custom genuinely ships none. */
ok(T.themeWall("glass")==="aurion","the default theme offers its own backdrop",T.themeWall("glass"));
/* Custom's "own picture" is the picture of the material it was promoted
   from - here midnight, from the two lines above. Custom ships no
   material of its own, so without this it would be the one theme whose
   first gallery tile said "this theme ships none" while the desk was
   plainly showing midnight's photograph. */
ok(T.themeWall("custom")==="midnight",
  "custom offers the picture of the material it was promoted from",T.themeWall("custom"));
/* And a Custom that was never promoted from anything genuinely ships
   none, which is the case this line has always been about. */
T.setCustom({material:""});
ok(T.themeWall("custom")==="",
  "a theme that ships no picture says so rather than inventing a filename");

// the custom theme too
T.set("custom");
T.edit({wall:"mono"});
ok(T.wall("custom")==="mono","the custom theme can have one as well");

console.log(f?`\nwallpapers: ${f} FAILED`:"\nwallpapers: all checks passed");
process.exit(f?1:0);
