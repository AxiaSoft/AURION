try {
  var prev = Session.Property("AURION_PREV_PATH") || "";
  var legacy = Session.Property("AURION_LEGACY") || "";
  var dest = Session.Property("INSTALLDIR") || "";
  var DATA_SUB = ""; // "resources" for the electron layout, "" for the script tree
  function log(msg) {
    try { var r = Session.Installer.CreateRecord(1); r.StringData(1) = "[AurionMigrateState] " + msg; Session.Message(0x04000000, r); } catch (e) {}
  }
  function stripSlash(s) { return (s || "").replace(/[\\\/]+$/, "").toLowerCase(); }
  if (dest) {
    var fsoObj = new ActiveXObject("Scripting.FileSystemObject");
    var sh = new ActiveXObject("WScript.Shell");
    function expand(s) { try { return sh.ExpandEnvironmentStrings(s); } catch (e) { return ""; } }
    var roots = [];
    if (prev) roots.push(prev);
    if (legacy) {
      var local = expand("%LOCALAPPDATA%\\Programs\\AURION");
      if (local && fsoObj.FileExists(local + "\\AURION.exe")) roots.push(local);
      var pf = expand("%ProgramFiles%\\AURION");
      if (pf && fsoObj.FileExists(pf + "\\AURION.exe")) roots.push(pf);
      var pf86 = expand("%ProgramFiles(x86)%\\AURION");
      if (pf86 && fsoObj.FileExists(pf86 + "\\AURION.exe")) roots.push(pf86);
    }
    for (var i = 0; i < roots.length; i++) {
      var root = roots[i];
      if (stripSlash(root) === stripSlash(dest)) continue;
      // data/ (holds the license in data/license) - carry it to the new home
      var dataCands = [root + "\\data", root + "\\resources\\data"];
      for (var j = 0; j < dataCands.length; j++) {
        if (fsoObj.FolderExists(dataCands[j])) {
          var destData = dest + (DATA_SUB ? "\\" + DATA_SUB : "") + "\\data";
          if (DATA_SUB && !fsoObj.FolderExists(dest + "\\" + DATA_SUB)) { try { fsoObj.CreateFolder(dest + "\\" + DATA_SUB); } catch (e) {} }
          if (!fsoObj.FolderExists(destData)) {
            try { fsoObj.CopyFolder(dataCands[j], destData); log("migrated data: " + dataCands[j]); }
            catch (e) { log("data copy failed: " + e.message); }
          }
          break;
        }
      }
      // user config (mt5 credentials, license otp) - copy only if not present
      var cfgCands = [root + "\\config", root + "\\resources\\config"];
      for (var k = 0; k < cfgCands.length; k++) {
        if (!fsoObj.FolderExists(cfgCands[k])) continue;
        var destCfg = dest + (DATA_SUB ? "\\" + DATA_SUB : "") + "\\config";
        if (!fsoObj.FolderExists(destCfg)) { try { fsoObj.CreateFolder(destCfg); } catch (e) {} }
        var cfgFiles = ["aurion.json", "news_calendar.csv", "news_calendar.fetched"];
        for (var m = 0; m < cfgFiles.length; m++) {
          var sf = cfgCands[k] + "\\" + cfgFiles[m];
          var df = destCfg + "\\" + cfgFiles[m];
          if (fsoObj.FileExists(sf) && !fsoObj.FileExists(df)) {
            try { fsoObj.CopyFile(sf, df, false); log("migrated config: " + cfgFiles[m]); }
            catch (e) { log("config copy failed: " + e.message); }
          }
        }
        break;
      }
    }
  }
} catch (e) {}