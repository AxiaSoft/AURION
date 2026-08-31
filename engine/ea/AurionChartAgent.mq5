//+------------------------------------------------------------------+
//| AurionChartAgent.mq5                                             |
//| Compile AurionBridge.mq5 and attach it. Set input InpEaName to   |
//| "AurionChartAgent" if you want this label on the desk.           |
//|                                                                  |
//| This file is intentionally a pointer, not a second copy of the   |
//| socket protocol — one compiled expert, many charts.              |
//+------------------------------------------------------------------+
#property copyright "AURION"
#property version   "1.17"
#property description "Use AurionBridge.mq5 1.17 — set InpEaName = AurionChartAgent"

int OnInit()
  {
   Print("AURION: compile and attach AurionBridge.mq5 1.17. Set InpEaName to AurionChartAgent.");
   return(INIT_FAILED);
  }
