//+------------------------------------------------------------------+
//| AurionChartAgent.mq5                                             |
//| Compile AurionBridge.mq5 and attach it. Set input InpEaName to   |
//| "AurionChartAgent" if you want this label on the desk.           |
//|                                                                  |
//| This file is intentionally a pointer, not a second copy of the   |
//| socket protocol — one compiled expert, many charts.              |
//+------------------------------------------------------------------+
#property copyright "AURION"
#define AURION_EA_VERSION "1.18"
#property version   "1.18"
#property description "Use AurionBridge.mq5 1.18 — set InpEaName = AurionChartAgent"

int OnInit()
  {
   Print("AURION: compile and attach AurionBridge.mq5 " + AURION_EA_VERSION + ". Set InpEaName to AurionChartAgent.");
   return(INIT_FAILED);
  }
