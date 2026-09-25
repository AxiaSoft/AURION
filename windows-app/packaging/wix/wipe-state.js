try {
  var dest = Session.Property("INSTALLDIR") || "";
  var DATA_SUB = "";
  if (dest) {
    var fso = new ActiveXObject("Scripting.FileSystemObject");
    var base = dest.replace(/[\\\/]+$/, "") + (DATA_SUB ? "\\" + DATA_SUB : "");
    var victims = [base + "\\data", base + "\\config\\aurion.json", base + "\\backend\\node_modules"];
    for (var i = 0; i < victims.length; i++) {
      try {
        if (fso.FolderExists(victims[i])) fso.DeleteFolder(victims[i], true);
        else if (fso.FileExists(victims[i])) fso.DeleteFile(victims[i], true);
      } catch (e) {}
    }
  }
} catch (e) {}