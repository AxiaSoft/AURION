//+------------------------------------------------------------------+
//| AurionBridge.mq5                                                 |
//| Live chart agent for the AURION engine.                          |
//|                                                                  |
//| v1.17 — tape separation. Every message (tick, candle, account,   |
//|   positions, orders, deals, bye, result) now carries tester=true |
//|   when it runs inside the Strategy Tester, so the desk keeps the |
//|   backtest tape apart from the live chart and never mixes them.  |
//|   OnTradeTransaction pushes positions/deals the instant a trade  |
//|   opens or closes — closed trades leave the desk right away.     |
//| Two pipes, either is enough:                                     |
//|   1) HTTP POST /v1/ea/ingest  (18765 then 8080)                  |
//|   2) FILE drop in Terminal Common\Files + this terminal Files    |
//| File drop does NOT need WebRequest allow-list.                   |
//| chart_id is a JSON string (ChartID exceeds JS safe integer).     |
//| WebRequest body is resized so a trailing NUL cannot poison JSON. |
//+------------------------------------------------------------------+
#property copyright "AURION"
#property link      "https://aurion.local"
#property version   "1.17"
#property strict
#property description "AURION live bridge 1.17 — tape separation + instant position push"

input string InpEngineHost   = "127.0.0.1";
input int    InpEnginePort   = 18766;
input int    InpHeartbeatMs  = 1000;
input int    InpCandleDepth  = 300;
input bool   InpSendHistory  = true;
input string InpEaName       = "AurionBridge";
input int    InpHttpPort     = 18765;

datetime g_last_bar = 0;
datetime g_deals_from = 0;
uint     g_last_beat = 0;
uint     g_up_since = 0;
uint     g_next_try = 0;
int      g_phase = 0;
bool     g_hello_ok = false;
bool     g_logged_http = false;
bool     g_logged_file = false;
int      g_http_port = 0;
string   g_hist_tfname = "";
int      g_hist_pos = -1;
int      g_hist_count = 0;
ENUM_TIMEFRAMES g_hist_tf = PERIOD_CURRENT;
MqlRates g_hist_rates[];
string   g_http_q[];

void BurstConnect();
bool FlushOut();
int ActiveHttpPort();
bool SendHello();
void SendTick();
void SendCandle(const int shift);
void SendAccount();
void SendPositions();
void SendOrders();
void SendDeals();
void QueueHistory(const string tfName);
void PumpHistory();
void MaybeClosedBar();
void PollCommands();
bool WriteInbox(const string json);

string ChartIdToken()
  {
   return IntegerToString(ChartID());
  }

string InboxName()
  {
   return "aurion_in_" + ChartIdToken() + ".jsonl";
  }

string CmdName()
  {
   return "aurion_cmd_" + ChartIdToken() + ".json";
  }

bool     g_tester = false;

int OnInit()
  {
   g_tester = (bool)MQLInfoInteger(MQL_TESTER);
   if(MQLInfoInteger(MQL_OPTIMIZATION))
     {
      Print("AURION: skip optimization pass.");
      return(INIT_SUCCEEDED);
     }
   if(g_tester)
      Print("AURION: Strategy Tester tape is tagged tester=true — desk will not mix it with the live chart.");
   g_hello_ok = false;
   g_phase = 0;
   g_up_since = 0;
   g_last_beat = 0;
   g_next_try = 0;
   g_hist_pos = -1;
   g_hist_count = 0;
   g_logged_http = false;
   g_logged_file = false;
   g_http_port = 0;
   ArrayResize(g_http_q, 0);
   g_deals_from = TimeCurrent();
   g_last_bar = iTime(_Symbol, _Period, 0);
   EventSetMillisecondTimer(50);
   Print("AURION: v1.17 FILE+HTTP  ", InpEngineHost, ":", InpHttpPort,
         "  common=", TerminalInfoString(TERMINAL_COMMONDATA_PATH),
         "\\Files\\", InboxName());
   Print("AURION: WebRequest is optional. File inbox feeds the desk even if HTTP is blocked.");
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   if(reason == REASON_REMOVE)
     {
      ArrayResize(g_http_q, 0);
      QueueOut("{\"type\":\"bye\",\"reason\":\"remove\",\"chart_id\":\"" +
               ChartIdToken() + "\",\"symbol\":\"" + JsonEsc(_Symbol) + "\"," +
               TapeTag() + "}");
      FlushOut();
     }
   ArrayResize(g_http_q, 0);
  }

void MaybeClosedBar()
  {
   datetime bar = iTime(_Symbol, _Period, 0);
   if(bar == 0)
      return;
   if(g_last_bar != 0 && bar != g_last_bar)
      SendCandle(1);
   g_last_bar = bar;
  }

void OnTick()
  {
   MaybeClosedBar();
   if(!g_hello_ok && GetTickCount() >= g_next_try)
      BurstConnect();
  }

void OnTimer()
  {
   uint now = GetTickCount();
   if(now < g_next_try)
      return;
   if(!g_hello_ok)
     {
      BurstConnect();
      return;
     }
   MaybeClosedBar();
   PollCommands();
   if(g_hist_pos >= 0)
      PumpHistory();
   if(now - g_last_beat >= (uint)InpHeartbeatMs)
     {
      g_last_beat = now;
      SendTick();
      SendCandle(0);
      SendAccount();
      SendPositions();
     }
   if(!FlushOut())
      g_next_try = now + 600;
   if(g_hist_pos < 0)
      EventSetMillisecondTimer(400);
  }

void BurstConnect()
  {
   ArrayResize(g_http_q, 0);
   SendHello();
   uint now = GetTickCount();
   if(!FlushOut())
     {
      g_next_try = now + 700;
      return;
     }
   g_hello_ok = true;
   g_up_since = now;
   g_last_beat = now;
   g_phase = 2;
   Print("AURION: hello delivered v1.17  HTTP port=", ActiveHttpPort(),
         "  file=", InboxName(), "  ", _Symbol, " ", TfName(_Period));
   SendTick();
   SendCandle(0);
   SendAccount();
   SendPositions();
   SendOrders();
   SendDeals();
   FlushOut();
   if(InpSendHistory)
     {
      QueueHistory("");
      PumpHistory();
      FlushOut();
     }
   EventSetMillisecondTimer(120);
  }

void OnTrade()
  {
   if(!g_hello_ok)
      return;
   SendAccount();
   SendPositions();
   SendOrders();
   SendDeals();
   FlushOut();
  }

// Fires on every trade transaction (fill, SL/TP hit, close). This is
// what keeps the desk honest: a closed position leaves the board the
// moment the terminal confirms it, not on the next slow heartbeat.
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
  {
   if(!g_hello_ok)
      return;
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD
      && trans.type != TRADE_TRANSACTION_POSITION
      && trans.type != TRADE_TRANSACTION_ORDER_DELETE
      && trans.type != TRADE_TRANSACTION_HISTORY_ADD)
      return;
   g_last_beat = GetTickCount();
   SendAccount();
   SendPositions();
   SendOrders();
   SendDeals();
   FlushOut();
  }

int ActiveHttpPort()
  {
   if(g_http_port > 0)
      return g_http_port;
   return InpHttpPort;
  }

string HttpUrlAt(const int port)
  {
   return "http://" + InpEngineHost + ":" + IntegerToString(port) + "/v1/ea/ingest";
  }

string WithChartId(const string json)
  {
   if(StringFind(json, "\"chart_id\"") >= 0)
      return json;
   int last = StringLen(json) - 1;
   if(last < 1 || StringGetCharacter(json, last) != '}')
      return json;
   return StringSubstr(json, 0, last) + ",\"chart_id\":\"" + ChartIdToken() + "\"}";
  }

void QueueOut(const string json)
  {
   int n = ArraySize(g_http_q);
   if(n >= 24)
      return;
   ArrayResize(g_http_q, n + 1);
   g_http_q[n] = WithChartId(json);
  }

bool SendRaw(const string json)
  {
   QueueOut(json);
   return true;
  }

bool EncodeUtf8(const string text, uchar &data[])
  {
   int n = StringToCharArray(text, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(n <= 1)
      return false;
   ArrayResize(data, n - 1);
   return true;
  }

bool AppendInboxFlags(const string json, const int common_flag)
  {
   string name = InboxName();
   int flags = FILE_READ | FILE_WRITE | FILE_BIN | FILE_SHARE_READ | FILE_SHARE_WRITE;
   if(common_flag != 0)
      flags |= FILE_COMMON;
   int h = FileOpen(name, flags);
   if(h == INVALID_HANDLE)
     {
      flags = FILE_WRITE | FILE_BIN | FILE_SHARE_READ | FILE_SHARE_WRITE;
      if(common_flag != 0)
         flags |= FILE_COMMON;
      h = FileOpen(name, flags);
      if(h == INVALID_HANDLE)
         return false;
     }
   if(FileSize(h) > 400000)
     {
      FileClose(h);
      FileDelete(name, common_flag);
      flags = FILE_WRITE | FILE_BIN | FILE_SHARE_READ | FILE_SHARE_WRITE;
      if(common_flag != 0)
         flags |= FILE_COMMON;
      h = FileOpen(name, flags);
      if(h == INVALID_HANDLE)
         return false;
     }
   FileSeek(h, 0, SEEK_END);
   uchar bytes[];
   if(!EncodeUtf8(json + "\n", bytes))
     {
      FileClose(h);
      return false;
     }
   FileWriteArray(h, bytes, 0, ArraySize(bytes));
   FileClose(h);
   return true;
  }

bool WriteInbox(const string json)
  {
   bool common_ok = AppendInboxFlags(json, FILE_COMMON);
   bool local_ok = AppendInboxFlags(json, 0);
   if((common_ok || local_ok) && !g_logged_file)
     {
      Print("AURION: file inbox writing ", InboxName(),
            " common=", (common_ok ? "yes" : "no"),
            " local=", (local_ok ? "yes" : "no"));
      g_logged_file = true;
     }
   return (common_ok || local_ok);
  }

string ReadCmdFlags(const int common_flag)
  {
   string name = CmdName();
   int flags = FILE_READ | FILE_BIN | FILE_SHARE_READ | FILE_SHARE_WRITE;
   if(common_flag != 0)
      flags |= FILE_COMMON;
   int h = FileOpen(name, flags);
   if(h == INVALID_HANDLE)
      return "";
   uchar bytes[];
   int n = (int)FileReadArray(h, bytes, 0, (int)FileSize(h));
   FileClose(h);
   if(n <= 0)
      return "";
   FileDelete(name, common_flag);
   return CharArrayToString(bytes, 0, n, CP_UTF8);
  }

void DropCmdFiles()
  {
   FileDelete(CmdName(), FILE_COMMON);
   FileDelete(CmdName());
  }

void PollCommands()
  {
   string line = ReadCmdFlags(FILE_COMMON);
   if(line == "")
      line = ReadCmdFlags(0);
   if(line == "")
      return;
   HandleCommand(line);
  }

bool PostJson(const string json, const int port)
  {
   uchar data[];
   char result[];
   string result_headers;
   if(!EncodeUtf8(json, data))
      return false;
   // WebRequest wants char[]; copy without a trailing NUL.
   char payload[];
   int n = ArraySize(data);
   ArrayResize(payload, n);
   for(int i = 0; i < n; i++)
      payload[i] = (char)data[i];
   string url = HttpUrlAt(port);
   ResetLastError();
   int code = WebRequest("POST", url, "Content-Type: application/json\r\n", 4000, payload, result, result_headers);
   if(code == -1)
     {
      ResetLastError();
      code = WebRequest("POST", url, "", "", 4000, payload, n, result, result_headers);
     }
   if(code == -1)
     {
      int err = GetLastError();
      if(!g_logged_http)
        {
         Print("AURION: WebRequest err=", err, " url=", url, " (file inbox still runs)");
         if(err == 4014 || err == 4060)
            Print("AURION: optional — allow WebRequest for 127.0.0.1, http://127.0.0.1, http://127.0.0.1:18765, http://127.0.0.1:8080");
         g_logged_http = true;
        }
      return false;
     }
   if(code != 200)
     {
      if(!g_logged_http)
        {
         Print("AURION: HTTP ingest status ", code, " url=", url);
         g_logged_http = true;
        }
      return false;
     }
   string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(Extract(resp, "ok") == "false")
     {
      if(!g_logged_http)
        {
         Print("AURION: ingest rejected url=", url, " ", StringSubstr(resp, 0, 160));
         g_logged_http = true;
        }
      return false;
     }
   if(g_logged_http)
     {
      Print("AURION: HTTP ingest recovered via ", url);
      g_logged_http = false;
     }
   if(Extract(resp, "has_cmd") == "true")
     {
      DropCmdFiles();
      HandleCommand(resp);
     }
   return true;
  }

bool FlushOut()
  {
   int nq = ArraySize(g_http_q);
   string json;
   if(nq <= 0)
      json = "{\"type\":\"ping\",\"chart_id\":\"" + ChartIdToken() +
             "\",\"symbol\":\"" + JsonEsc(_Symbol) +
             "\",\"timeframe_name\":\"" + TfName(_Period) + "\"," + TapeTag() + "}";
   else if(nq == 1)
      json = g_http_q[0];
   else
     {
      json = "{\"type\":\"bundle\",\"chart_id\":\"" + ChartIdToken() + "\"," + TapeTag() + ",\"messages\":[";
      for(int i = 0; i < nq; i++)
        {
         if(i > 0)
            json += ",";
         json += g_http_q[i];
        }
      json += "]}";
     }
   int primary = ActiveHttpPort();
   int alt = (primary == 8080 ? InpHttpPort : 8080);
   bool posted = false;
   if(PostJson(json, primary))
     {
      g_http_port = primary;
      posted = true;
     }
   else if(alt != primary && PostJson(json, alt))
     {
      g_http_port = alt;
      posted = true;
      Print("AURION: ingest switched to port ", alt);
     }
   bool wrote = false;
   if(!posted)
      wrote = WriteInbox(json);
   if(posted || wrote)
     {
      ArrayResize(g_http_q, 0);
      return true;
     }
   return false;
  }

string JsonEsc(const string s)
  {
   string o = "";
   int n = StringLen(s);
   for(int i = 0; i < n; i++)
     {
      int ch = StringGetCharacter(s, i);
      if(ch == 92)
         o += "\\\\";
      else if(ch == 34)
         o += "\\\"";
      else if(ch == 10)
         o += "\\n";
      else if(ch == 13)
         continue;
      else if(ch == 9)
         o += "\\t";
      else if(ch < 32)
         continue;
      else
         o += ShortToString((ushort)ch);
     }
   return o;
  }

string IsoTime(datetime t)
  {
   MqlDateTime dt;
   TimeToStruct(t, dt);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02d", dt.year, dt.mon, dt.day, dt.hour, dt.min, dt.sec);
  }

string TapeTag()
  {
   return "\"mode\":\"" + (g_tester ? "tester" : "live") + "\",\"tester\":" + (g_tester ? "true" : "false");
  }

bool SendHello()
  {
   string json = "{";
   json += "\"type\":\"hello\",";
   json += "\"role\":\"ea\",";
   json += "\"protocol\":\"aurion-mt5-1\",";
   json += "\"chart_id\":\"" + ChartIdToken() + "\",";
   json += "\"symbol\":\"" + JsonEsc(_Symbol) + "\",";
   json += "\"timeframe\":" + IntegerToString(PeriodSeconds(_Period) / 60) + ",";
   json += "\"timeframe_name\":\"" + TfName(_Period) + "\",";
   json += "\"ea_name\":\"" + JsonEsc(InpEaName) + "\",";
   json += "\"version\":\"1.17\",";
   json += "\"transport\":\"file+http\",";
   json += TapeTag();
   json += "}";
   return SendRaw(json);
  }

void SendTick()
  {
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return;
   string json = "{";
   json += "\"type\":\"tick\",";
   json += "\"symbol\":\"" + JsonEsc(_Symbol) + "\",";
   json += "\"timeframe_name\":\"" + TfName(_Period) + "\",";
   json += "\"time\":\"" + IsoTime(tick.time) + "\",";
   json += "\"time_msc\":" + IntegerToString(tick.time_msc) + ",";
   json += "\"bid\":" + DoubleToString(tick.bid, _Digits) + ",";
   json += "\"ask\":" + DoubleToString(tick.ask, _Digits) + ",";
   json += "\"last\":" + DoubleToString(tick.last, _Digits) + ",";
   json += "\"volume\":" + DoubleToString((double)tick.volume, 0) + ",";
   json += TapeTag();
   json += "}";
   SendRaw(json);
  }

void SendCandle(const int shift)
  {
   datetime t = iTime(_Symbol, _Period, shift);
   if(t == 0)
      return;
   string json = "{";
   json += "\"type\":\"candle\",";
   json += "\"symbol\":\"" + JsonEsc(_Symbol) + "\",";
   json += "\"timeframe\":" + IntegerToString(PeriodSeconds(_Period) / 60) + ",";
   json += "\"timeframe_name\":\"" + TfName(_Period) + "\",";
   json += "\"time\":\"" + IsoTime(t) + "\",";
   json += "\"time_msc\":" + IntegerToString((long)t * 1000) + ",";
   json += "\"open\":" + DoubleToString(iOpen(_Symbol, _Period, shift), _Digits) + ",";
   json += "\"high\":" + DoubleToString(iHigh(_Symbol, _Period, shift), _Digits) + ",";
   json += "\"low\":" + DoubleToString(iLow(_Symbol, _Period, shift), _Digits) + ",";
   json += "\"close\":" + DoubleToString(iClose(_Symbol, _Period, shift), _Digits) + ",";
   json += "\"volume\":" + DoubleToString((double)iVolume(_Symbol, _Period, shift), 0) + ",";
   json += "\"closed\":" + (shift > 0 ? "true" : "false") + ",";
   json += TapeTag();
   json += "}";
   SendRaw(json);
  }

ENUM_TIMEFRAMES PeriodFromName(const string name)
  {
   if(name == "M1" || name == "1") return PERIOD_M1;
   if(name == "M5" || name == "5") return PERIOD_M5;
   if(name == "M15" || name == "15") return PERIOD_M15;
   if(name == "M30" || name == "30") return PERIOD_M30;
   if(name == "H1" || name == "60") return PERIOD_H1;
   if(name == "H4" || name == "240") return PERIOD_H4;
   if(name == "D1" || name == "1440") return PERIOD_D1;
   return _Period;
  }

void QueueHistory(const string tfName)
  {
   g_hist_tfname = tfName;
   g_hist_pos = 0;
   g_hist_count = 0;
   ArrayFree(g_hist_rates);
  }

void PumpHistory()
  {
   if(g_hist_pos < 0)
      return;
   if(g_hist_count <= 0)
     {
      g_hist_tf = (g_hist_tfname == "" ? _Period : PeriodFromName(g_hist_tfname));
      int depth = InpCandleDepth;
      if(depth < 50) depth = 50;
      if(depth > 400) depth = 400;
      ArraySetAsSeries(g_hist_rates, false);
      int n = CopyRates(_Symbol, g_hist_tf, 0, depth, g_hist_rates);
      if(n <= 0)
        {
         g_hist_pos = -1;
         return;
        }
      g_hist_count = n;
      g_hist_pos = 0;
     }
   int start = g_hist_pos;
   int endd = start + 60;
   if(endd > g_hist_count) endd = g_hist_count;
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   string json = "{\"type\":\"candles\"," + TapeTag() + ",\"symbol\":\"" + JsonEsc(_Symbol) + "\",";
   json += "\"timeframe\":" + IntegerToString(PeriodSeconds(g_hist_tf) / 60) + ",";
   json += "\"timeframe_name\":\"" + TfName(g_hist_tf) + "\",";
   json += "\"replace\":" + (start == 0 ? "true" : "false") + ",";
   json += "\"final\":" + (endd >= g_hist_count ? "true" : "false") + ",";
   json += "\"bars\":[";
   for(int i = start; i < endd; i++)
     {
      if(i > start) json += ",";
      json += "{\"time\":\"" + IsoTime(g_hist_rates[i].time) + "\",";
      json += "\"open\":" + DoubleToString(g_hist_rates[i].open, digits) + ",";
      json += "\"high\":" + DoubleToString(g_hist_rates[i].high, digits) + ",";
      json += "\"low\":" + DoubleToString(g_hist_rates[i].low, digits) + ",";
      json += "\"close\":" + DoubleToString(g_hist_rates[i].close, digits) + ",";
      json += "\"volume\":" + DoubleToString((double)g_hist_rates[i].tick_volume, 0) + "}";
     }
   json += "]}";
   SendRaw(json);
   g_hist_pos = endd;
   if(endd >= g_hist_count)
     {
      g_hist_pos = -1;
      g_hist_count = 0;
      ArrayFree(g_hist_rates);
     }
  }

void SendAccount()
  {
   string json = "{";
   json += "\"type\":\"account\",";
   json += "\"login\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ",";
   json += "\"name\":\"" + JsonEsc(AccountInfoString(ACCOUNT_NAME)) + "\",";
   json += "\"server\":\"" + JsonEsc(AccountInfoString(ACCOUNT_SERVER)) + "\",";
   json += "\"currency\":\"" + JsonEsc(AccountInfoString(ACCOUNT_CURRENCY)) + "\",";
   json += "\"company\":\"" + JsonEsc(AccountInfoString(ACCOUNT_COMPANY)) + "\",";
   json += "\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) + ",";
   json += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   json += "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   json += "\"margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + ",";
   json += "\"margin_free\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ",";
   json += "\"margin_level\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2) + ",";
   json += "\"profit\":" + DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2) + ",";
   json += "\"credit\":" + DoubleToString(AccountInfoDouble(ACCOUNT_CREDIT), 2) + ",";
   json += "\"trade_allowed\":" + (AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) ? "true" : "false") + ",";
   json += "\"trade_expert\":" + (AccountInfoInteger(ACCOUNT_TRADE_EXPERT) ? "true" : "false") + ",";
   json += "\"trade_mode\":" + IntegerToString(AccountInfoInteger(ACCOUNT_TRADE_MODE)) + ",";
   json += "\"margin_mode\":" + IntegerToString(AccountInfoInteger(ACCOUNT_MARGIN_MODE));
   json += "," + TapeTag();
   json += "}";
   SendRaw(json);
  }

void SendPositions()
  {
   string json = "{\"type\":\"positions\"," + TapeTag() + ",\"items\":[";
   bool first = true;
   int total = PositionsTotal();
   if(total > 40) total = 40;
   for(int i = 0; i < total; i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(!first) json += ",";
      first = false;
      string type = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? "buy" : "sell";
      json += "{";
      json += "\"ticket\":" + IntegerToString((long)ticket) + ",";
      json += "\"symbol\":\"" + JsonEsc(PositionGetString(POSITION_SYMBOL)) + "\",";
      json += "\"type\":\"" + type + "\",";
      json += "\"volume\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + ",";
      json += "\"price_open\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), _Digits) + ",";
      json += "\"price_current\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_CURRENT), _Digits) + ",";
      json += "\"sl\":" + DoubleToString(PositionGetDouble(POSITION_SL), _Digits) + ",";
      json += "\"tp\":" + DoubleToString(PositionGetDouble(POSITION_TP), _Digits) + ",";
      json += "\"profit\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2) + ",";
      json += "\"time\":\"" + IsoTime((datetime)PositionGetInteger(POSITION_TIME)) + "\",";
      json += "\"magic\":" + IntegerToString((long)PositionGetInteger(POSITION_MAGIC)) + ",";
      json += "\"comment\":\"" + JsonEsc(PositionGetString(POSITION_COMMENT)) + "\"";
      json += "}";
     }
   json += "]}";
   SendRaw(json);
  }

void SendDeals()
  {
   datetime to = TimeCurrent();
   datetime from = g_deals_from;
   if(from <= 0)
      from = to;
   // Session-only. Never dump the broker's week of history into AURION.
   if(from >= to)
     {
      g_deals_from = to;
      return;
     }
   if(!HistorySelect(from, to))
      return;
   int total = HistoryDealsTotal();
   if(total <= 0)
      return;
   int start = total - 80;
   if(start < 0)
      start = 0;
   string json = "{\"type\":\"deals\"," + TapeTag() + ",\"items\":[";
   bool first = true;
   for(int i = start; i < total; i++)
     {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0)
         continue;
      string symbol = HistoryDealGetString(ticket, DEAL_SYMBOL);
      long entry_code = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      string entry = "in";
      if(entry_code == DEAL_ENTRY_OUT || entry_code == DEAL_ENTRY_OUT_BY)
         entry = "out";
      else if(entry_code == DEAL_ENTRY_INOUT)
         entry = "inout";
      long dtype = HistoryDealGetInteger(ticket, DEAL_TYPE);
      if(dtype != DEAL_TYPE_BUY && dtype != DEAL_TYPE_SELL)
         continue;
      string type = (dtype == DEAL_TYPE_SELL) ? "sell" : "buy";
      int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
      if(digits <= 0)
         digits = _Digits;
      if(!first)
         json += ",";
      first = false;
      json += "{";
      json += "\"ticket\":" + IntegerToString((long)ticket) + ",";
      json += "\"order\":" + IntegerToString((long)HistoryDealGetInteger(ticket, DEAL_ORDER)) + ",";
      json += "\"position_id\":" + IntegerToString((long)HistoryDealGetInteger(ticket, DEAL_POSITION_ID)) + ",";
      json += "\"symbol\":\"" + JsonEsc(symbol) + "\",";
      json += "\"type\":\"" + type + "\",";
      json += "\"entry\":\"" + entry + "\",";
      json += "\"volume\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_VOLUME), 2) + ",";
      json += "\"price\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_PRICE), digits) + ",";
      json += "\"profit\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_PROFIT), 2) + ",";
      json += "\"swap\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_SWAP), 2) + ",";
      json += "\"commission\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_COMMISSION), 2) + ",";
      json += "\"time\":\"" + IsoTime((datetime)HistoryDealGetInteger(ticket, DEAL_TIME)) + "\",";
      json += "\"magic\":" + IntegerToString((long)HistoryDealGetInteger(ticket, DEAL_MAGIC)) + ",";
      json += "\"comment\":\"" + JsonEsc(HistoryDealGetString(ticket, DEAL_COMMENT)) + "\"";
      json += "}";
     }
   json += "]}";
   if(!first)
      SendRaw(json);
   g_deals_from = to;
  }

void SendOrders()
  {
   string json = "{\"type\":\"orders\"," + TapeTag() + ",\"items\":[";
   bool first = true;
   int total = OrdersTotal();
   if(total > 40) total = 40;
   for(int i = 0; i < total; i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(!first) json += ",";
      first = false;
      json += "{";
      json += "\"ticket\":" + IntegerToString((long)ticket) + ",";
      json += "\"symbol\":\"" + JsonEsc(OrderGetString(ORDER_SYMBOL)) + "\",";
      json += "\"type\":\"" + OrderTypeName((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE)) + "\",";
      json += "\"volume\":" + DoubleToString(OrderGetDouble(ORDER_VOLUME_CURRENT), 2) + ",";
      json += "\"price\":" + DoubleToString(OrderGetDouble(ORDER_PRICE_OPEN), _Digits);
      json += "}";
     }
   json += "]}";
   SendRaw(json);
  }

string OrderTypeName(const ENUM_ORDER_TYPE t)
  {
   if(t == ORDER_TYPE_BUY) return "buy";
   if(t == ORDER_TYPE_SELL) return "sell";
   if(t == ORDER_TYPE_BUY_LIMIT) return "buy_limit";
   if(t == ORDER_TYPE_SELL_LIMIT) return "sell_limit";
   if(t == ORDER_TYPE_BUY_STOP) return "buy_stop";
   if(t == ORDER_TYPE_SELL_STOP) return "sell_stop";
   return "other";
  }

string TfName(const ENUM_TIMEFRAMES tf)
  {
   if(tf == PERIOD_M1) return "M1";
   if(tf == PERIOD_M5) return "M5";
   if(tf == PERIOD_M15) return "M15";
   if(tf == PERIOD_M30) return "M30";
   if(tf == PERIOD_H1) return "H1";
   if(tf == PERIOD_H4) return "H4";
   if(tf == PERIOD_D1) return "D1";
   return IntegerToString(PeriodSeconds(tf) / 60);
  }

string Extract(const string json, const string key)
  {
   string pat = "\"" + key + "\"";
   int i = StringFind(json, pat);
   if(i < 0) return "";
   int colon = StringFind(json, ":", i);
   if(colon < 0) return "";
   int p = colon + 1;
   while(p < StringLen(json) && StringGetCharacter(json, p) == ' ') p++;
   if(p < StringLen(json) && StringGetCharacter(json, p) == '"')
     {
      int end = StringFind(json, "\"", p + 1);
      if(end < 0) return "";
      return StringSubstr(json, p + 1, end - p - 1);
     }
   int end = p;
   while(end < StringLen(json))
     {
      int ch = StringGetCharacter(json, end);
      if(ch == ',' || ch == '}' || ch == ']') break;
      end++;
     }
   string raw = StringSubstr(json, p, end - p);
   StringTrimLeft(raw);
   StringTrimRight(raw);
   return raw;
  }

void HandleCommand(const string line)
  {
   if(StringLen(line) < 5) return;
   string type = Extract(line, "type");
   if(type == "hello" || type == "pong" || type == "ping") return;
   if(type == "order" || type == "market") { TradeMarket(line); return; }
   if(type == "close") { TradeClose(line); return; }
   if(type == "modify") { TradeModify(line); return; }
   if(type == "flatten") { Flatten(); return; }
   if(type == "request_history")
     {
      string want = Extract(line, "symbol");
      if(want != "" && !SameSymbol(want, _Symbol)) return;
      string tf = Extract(line, "timeframe_name");
      if(tf == "") tf = Extract(line, "timeframe");
      QueueHistory(tf);
     }
  }

void Reply(const bool ok, const string detail)
  {
   SendRaw("{\"type\":\"result\",\"ok\":" + (ok ? "true" : "false") +
           ",\"detail\":\"" + JsonEsc(detail) + "\",\"symbol\":\"" + JsonEsc(_Symbol) + "\"," + TapeTag() + "}");
   SendPositions();
   SendAccount();
   FlushOut();
  }

bool SameSymbol(const string a, const string b)
  {
   if(a == "" || b == "") return false;
   string ua = a, ub = b;
   StringToUpper(ua);
   StringToUpper(ub);
   return (ua == ub || StringFind(ua, ub) == 0 || StringFind(ub, ua) == 0);
  }

ENUM_ORDER_TYPE_FILLING FillOf(const string symbol)
  {
   long mode = SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   if((mode & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC) return ORDER_FILLING_IOC;
   if((mode & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) return ORDER_FILLING_FOK;
   return ORDER_FILLING_RETURN;
  }

void TradeMarket(const string line)
  {
   string want = Extract(line, "symbol");
   if(want != "" && !SameSymbol(want, _Symbol)) return;
   if(g_tester) { Reply(false, "tester tape is read-only — live orders stay on the main chart"); return; }
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) { Reply(false, "terminal AutoTrading is OFF"); return; }
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) { Reply(false, "AutoTrading is OFF on this chart"); return; }
   string side = Extract(line, "side");
   if(side == "" || side == "market" || side == "order") side = Extract(line, "action");
   StringToLower(side);
   double volume = StringToDouble(Extract(line, "volume"));
   double sl = StringToDouble(Extract(line, "sl"));
   double tp = StringToDouble(Extract(line, "tp"));
   if(volume <= 0) { Reply(false, "volume required"); return; }
   MqlTradeRequest req;
   MqlTradeResult res;
   ZeroMemory(req);
   ZeroMemory(res);
   req.action = TRADE_ACTION_DEAL;
   req.symbol = _Symbol;
   req.volume = volume;
   req.deviation = 30;
   req.magic = 908173;
   string cmt = Extract(line, "comment");
   if(cmt == "") cmt = "AURION";
   if(StringLen(cmt) > 31) cmt = StringSubstr(cmt, 0, 31);
   req.comment = cmt;
   if(side == "sell")
     {
      req.type = ORDER_TYPE_SELL;
      req.price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
     }
   else
     {
      req.type = ORDER_TYPE_BUY;
      req.price = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
     }
   if(sl > 0.0) req.sl = sl;
   if(tp > 0.0) req.tp = tp;
   ENUM_ORDER_TYPE_FILLING fills[3];
   fills[0] = FillOf(_Symbol);
   fills[1] = ORDER_FILLING_IOC;
   fills[2] = ORDER_FILLING_FOK;
   bool ok = false;
   for(int i = 0; i < 3; i++)
     {
      ZeroMemory(res);
      req.type_filling = fills[i];
      ok = OrderSend(req, res);
      if(ok && (res.retcode == TRADE_RETCODE_DONE || res.retcode == TRADE_RETCODE_PLACED || res.retcode == TRADE_RETCODE_DONE_PARTIAL))
         break;
      if(res.retcode != TRADE_RETCODE_INVALID_FILL) break;
     }
   bool good = ok && (res.retcode == TRADE_RETCODE_DONE || res.retcode == TRADE_RETCODE_PLACED || res.retcode == TRADE_RETCODE_DONE_PARTIAL);
   Reply(good, "retcode=" + IntegerToString(res.retcode) + " " + res.comment);
  }

void TradeClose(const string line)
  {
   ulong ticket = (ulong)StringToInteger(Extract(line, "ticket"));
   if(ticket == 0) { Reply(false, "ticket required"); return; }
   if(!PositionSelectByTicket(ticket)) { Reply(false, "position not found"); return; }
   string symbol = PositionGetString(POSITION_SYMBOL);
   double volume = PositionGetDouble(POSITION_VOLUME);
   long type = PositionGetInteger(POSITION_TYPE);
   MqlTradeRequest req;
   MqlTradeResult res;
   ZeroMemory(req);
   ZeroMemory(res);
   req.action = TRADE_ACTION_DEAL;
   req.position = ticket;
   req.symbol = symbol;
   req.volume = volume;
   req.deviation = 20;
   req.magic = 908173;
   req.comment = "AURION close";
   req.type_filling = ORDER_FILLING_IOC;
   if(type == POSITION_TYPE_BUY)
     {
      req.type = ORDER_TYPE_SELL;
      req.price = SymbolInfoDouble(symbol, SYMBOL_BID);
     }
   else
     {
      req.type = ORDER_TYPE_BUY;
      req.price = SymbolInfoDouble(symbol, SYMBOL_ASK);
     }
   bool ok = OrderSend(req, res);
   Reply(ok && (res.retcode == TRADE_RETCODE_DONE || res.retcode == TRADE_RETCODE_PLACED),
         "retcode=" + IntegerToString(res.retcode));
  }

void TradeModify(const string line)
  {
   ulong ticket = (ulong)StringToInteger(Extract(line, "ticket"));
   if(!PositionSelectByTicket(ticket)) { Reply(false, "position not found"); return; }
   MqlTradeRequest req;
   MqlTradeResult res;
   ZeroMemory(req);
   ZeroMemory(res);
   req.action = TRADE_ACTION_SLTP;
   req.position = ticket;
   req.symbol = PositionGetString(POSITION_SYMBOL);
   req.sl = StringToDouble(Extract(line, "sl"));
   req.tp = StringToDouble(Extract(line, "tp"));
   bool ok = OrderSend(req, res);
   Reply(ok, "retcode=" + IntegerToString(res.retcode));
  }

void Flatten()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      TradeClose("{\"ticket\":\"" + IntegerToString((long)ticket) + "\"}");
     }
  }
//+------------------------------------------------------------------+
