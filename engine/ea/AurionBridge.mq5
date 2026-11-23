//+------------------------------------------------------------------+
//| AurionBridge.mq5                                                 |
//| Live chart agent for the AURION engine.                          |
//|                                                                  |
//| v1.23 — the price goes out as the market makes it. Until now a  |
//|   quote travelled only on the 1s heartbeat, bundled with the     |
//|   account, the forming candle and every open position, so the    |
//|   desk learned the price once a second however fast the market   |
//|   moved and visibly lagged the terminal beside it. OnTick now    |
//|   sends the four numbers of a tick on their own, at most every   |
//|   InpTickMs (200ms by default, 0 to disable). The heartbeat is   |
//|   unchanged and still carries everything else.                   |
//|                                                                  |
//| v1.22 — the bars this terminal already holds are sent FIRST, and |
//|   the deeper period is fetched behind them. 1.21 asked only for  |
//|   a date range, and a range the terminal has no series for is    |
//|   answered -1 while MetaTrader downloads it: on a timeframe the  |
//|   chart has never been opened on that is every attempt for up to |
//|   a minute and a half, far past the engine's timeout, so the     |
//|   desk drew nothing at all unless the MetaTrader chart was put   |
//|   on the same timeframe by hand. Now phase one answers out of    |
//|   the series (fast, any timeframe) and phase two re-sends the    |
//|   whole period when the download lands, with replace:true.       |
//|   The stream is also 250 bars a chunk on a 25ms timer instead of |
//|   60 on a 400ms one - six months of M15 took two minutes to      |
//|   dribble out, which no caller waits for.                        |
//|                                                                  |
//| v1.21 — history is asked for as a PERIOD, not as a bar count.    |
//|   CopyRates(sym, tf, 0, depth, ...) is served out of the series   |
//|   the terminal has already built, and never makes it fetch more,  |
//|   so a deep ask was silently answered with whatever was loaded:   |
//|   MetaTrader scrolled back months while AURION drew weeks. The    |
//|   date-range form is what triggers the download, and the retry    |
//|   ladder below already covers the "-1 while downloading" reply.   |
//|   If the broker refuses the whole period we now fall back to the  |
//|   bars this terminal does hold instead of sending nothing.        |
//|                                                                  |
//| v1.20 — a history request is no longer abandoned the first time  |
//|   MetaTrader says "not yet". CopyRates answers -1 while it is    |
//|   still fetching a series from the broker, which is the normal   |
//|   first answer on a timeframe this chart has never opened; the   |
//|   old code read that as "no history" and went silent for good.   |
//|   It now re-asks on a widening delay, and when it finally gives  |
//|   up it SAYS so, carrying how many bars the terminal actually    |
//|   holds and the date of the oldest one, so the desk can tell a   |
//|   broker's limit from a "Max bars in chart" setting.             |
//|                                                                  |
//| v1.19 — the engine names the depth, this expert honours it. The  |
//|   depth was clamped to 400 bars, which is six hours of M1, so a  |
//|   desk that fell back to this pipe could never show, train on or |
//|   backtest the window AURION promises. Nothing here states a     |
//|   number of days on purpose: the window is the engine's to set   |
//|   (it is 180 days as this is written, up from 30), and an expert |
//|   that agreed with it in a comment would be the copy that goes   |
//|   stale. The ceiling below is the only limit this file imposes.  |
//| v1.18 — the desk can now see which expert is attached. Hello     |
//|   carries the version from one #define instead of a literal      |
//|   typed twice, and the desk compares it with the version it       |
//|   ships: an old expert on a chart is reported, not guessed at.   |
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
// One version string for this expert.
//
// It used to be typed in three places - the property, the hello message
// and the description - and the one on the wire is the one the desk
// judges, so a missed edit meant the desk saw 1.16 from a 1.17 expert and
// nobody could tell. AURION_EA_VERSION is the value sent to the engine;
// engine/tests/test_ea_version.py fails the build if the #property below
// drifts from it, because #property will not take a macro.
#define AURION_EA_VERSION "1.23"
#property version   "1.23"
#property strict
#property description "AURION live bridge 1.23 — price goes out as the market makes it, not on the heartbeat"

input string InpEngineHost   = "127.0.0.1";
input int    InpEnginePort   = 18766;
input int    InpHeartbeatMs  = 1000;
/* How often the PRICE may go out, apart from the heartbeat.
 *
 * Reported: "the live price of each symbol has to be in the moment,
 * the same as MetaTrader - it is shown much slower". It was. The
 * quote travelled only on the heartbeat, bundled with the account,
 * the forming candle and the whole position list, so the desk learnt
 * the price once a second however fast the market moved - and on a
 * fast instrument a second is a long way behind the terminal.
 *
 * A tick is four numbers. Sending one does not need the rest of the
 * heartbeat's payload, and OnTick is where the terminal already tells
 * us the price changed. 200ms is five updates a second: visibly live,
 * and far below the rate at which a localhost POST costs anything.
 * Set to 0 to go back to heartbeat-only quotes. */
input int    InpTickMs       = 200;
// Fallback depth, used only when the engine does not name one. The
// engine asks for its own window of the timeframe in question; this is
// what an unprompted history push sends.
input int    InpCandleDepth  = 3000;
// Ceiling for a single history push, so a bad request cannot ask the
// terminal for a decade. 300 000 M1 bars is about seven months, which
// clears the six-month window the desk asks for.
#define AURION_HIST_MAX 300000
// How many times to re-ask CopyRates while MetaTrader downloads the
// series in the background. At a widening 250ms..3s delay this is
// roughly a minute and a half of patience, which covers a cold M1
// series on a slow link without hanging the request for ever.
#define AURION_HIST_TRIES 40
// The same patience, but for phase one, which only asks for what the
// terminal has already built. That answer either comes in the first
// second or it is not coming at all, and every attempt here is time
// the desk spends with an empty chart.
#define AURION_HIST_QUICK_TRIES 8
// Bars per message. 60 was a safe guess made when a request was a few
// hundred bars; at one chunk per timer pass it means six months of
// M15 (17 280 bars) takes 288 passes, which was two minutes of
// dribbling history while the engine's 25-second patience ran out.
#define AURION_HIST_CHUNK 250
input bool   InpSendHistory  = true;
input string InpEaName       = "AurionBridge";
input int    InpHttpPort     = 18765;

datetime g_last_bar = 0;
/* The timeframe the DESK is looking at, which is not necessarily the
   one this MetaTrader chart is on.
   Every live message used to be built from _Period alone, so a trader
   who switched timeframe in AURION got the history for the new
   timeframe once and then nothing: no closing bars, no forming bar,
   a chart frozen at the moment it was drawn - unless they went into
   MetaTrader and switched that chart too, which is exactly what was
   reported. The last timeframe the engine asked history for is
   remembered here and fed alongside _Period, never instead of it:
   the chart's own timeframe is what the built-in strategies are
   evaluated on, and that must keep flowing whatever the desk shows. */
ENUM_TIMEFRAMES g_feed_tf = PERIOD_CURRENT;
datetime g_feed_bar = 0;
datetime g_deals_from = 0;
uint     g_last_beat = 0;
uint     g_last_quote = 0;
uint     g_last_spec      = 0;
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
int      g_hist_want = 0;
int      g_hist_tries = 0;
uint     g_hist_next = 0;
ENUM_TIMEFRAMES g_hist_tf = PERIOD_CURRENT;
MqlRates g_hist_rates[];
// Which half of the answer is in flight: 0 = the bars this terminal
// already holds, 1 = the period the broker has to be asked for.
int      g_hist_phase = 0;
// How many bars phase one delivered, so phase two only re-sends the
// stream when it has MORE than the desk is already drawing.
int      g_hist_sent = 0;
string   g_http_q[];

void BurstConnect();
bool FlushOut();
int ActiveHttpPort();
bool SendHello();
void SendTick();
void SendCandle(const int shift);
void SendCandleOn(const ENUM_TIMEFRAMES tf, const int shift);
void SendAccount();
void SendSpec();
void SendPositions();
void SendOrders();
void SendDeals();
void QueueHistory(const string tfName, const int want);
void PumpHistory();
string HistoryDepthTag(const ENUM_TIMEFRAMES tf, const int requested);
void SendHistoryShortfall(const int requested);
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
   g_last_quote = 0;
   g_next_try = 0;
   g_hist_pos = -1;
   g_hist_count = 0;
   g_hist_tries = 0;
   g_hist_next = 0;
   g_hist_phase = 0;
   g_hist_sent = 0;
   g_logged_http = false;
   g_logged_file = false;
   g_http_port = 0;
   ArrayResize(g_http_q, 0);
   g_deals_from = TimeCurrent();
   g_last_bar = iTime(_Symbol, _Period, 0);
   g_feed_tf = PERIOD_CURRENT;
   g_feed_bar = 0;
   EventSetMillisecondTimer(50);
   Print("AURION: v" + AURION_EA_VERSION + " FILE+HTTP  ", InpEngineHost, ":", InpHttpPort,
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
   if(bar != 0)
     {
      if(g_last_bar != 0 && bar != g_last_bar)
         SendCandle(1);
      g_last_bar = bar;
     }
   // And the same for the timeframe the desk is showing, when that is
   // a different one. A desk chart that never receives a closed bar
   // stops growing the moment its history has been drawn.
   if(g_feed_tf == PERIOD_CURRENT || g_feed_tf == _Period)
      return;
   datetime fbar = iTime(_Symbol, g_feed_tf, 0);
   if(fbar == 0)
      return;
   if(g_feed_bar != 0 && fbar != g_feed_bar)
      SendCandleOn(g_feed_tf, 1);
   g_feed_bar = fbar;
  }

void OnTick()
  {
   MaybeClosedBar();
   if(!g_hello_ok && GetTickCount() >= g_next_try)
     {
      BurstConnect();
      return;
     }
   // The price, as the market makes it. See InpTickMs.
   if(g_hello_ok && InpTickMs > 0)
     {
      uint now = GetTickCount();
      if(now - g_last_quote >= (uint)InpTickMs && now >= g_next_try)
        {
         g_last_quote = now;
         SendTick();
         if(!FlushOut())
            g_next_try = now + 600;
        }
     }
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
     {
      /* History moves at the timer's speed, and the timer is a
         quarter-second heartbeat. At one chunk a pass, six months of
         M15 is 288 passes - nearly two minutes of history dribbling
         out while the engine's patience (eight to twenty-five
         seconds) runs out and the desk draws whatever arrived. So
         while a stream is in flight, several chunks go per pass and
         the timer runs fast; it drops back to the heartbeat below
         the moment the stream ends. */
      for(int k = 0; k < 4 && g_hist_pos >= 0; k++)
         PumpHistory();
      EventSetMillisecondTimer(25);
     }
   if(now - g_last_beat >= (uint)InpHeartbeatMs)
     {
      g_last_beat = now;
      g_last_quote = now;
      SendTick();
      SendCandle(0);
      SendAccount();
      SendPositions();
      if(now - g_last_spec >= 60000)
        {
         g_last_spec = now;
         SendSpec();
        }
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
   Print("AURION: hello delivered v" + AURION_EA_VERSION + "  HTTP port=", ActiveHttpPort(),
         "  file=", InboxName(), "  ", _Symbol, " ", TfName(_Period));
   SendTick();
   SendCandle(0);
   SendSpec();
   SendAccount();
   SendPositions();
   SendOrders();
   SendDeals();
   FlushOut();
   if(InpSendHistory)
     {
      QueueHistory("", 0);
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
   json += "\"version\":\"" + AURION_EA_VERSION + "\",";
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

/* One candle, on a named timeframe.
   The timeframe is a parameter rather than _Period because the desk
   can be showing a different one; see g_feed_tf. */
void SendCandleOn(const ENUM_TIMEFRAMES tf, const int shift)
  {
   ENUM_TIMEFRAMES use = (tf == PERIOD_CURRENT ? _Period : tf);
   datetime t = iTime(_Symbol, use, shift);
   if(t == 0)
      return;
   string json = "{";
   json += "\"type\":\"candle\",";
   json += "\"symbol\":\"" + JsonEsc(_Symbol) + "\",";
   json += "\"timeframe\":" + IntegerToString(PeriodSeconds(use) / 60) + ",";
   json += "\"timeframe_name\":\"" + TfName(use) + "\",";
   // The timeframe of the MetaTrader CHART, which is not the same
   // thing as the timeframe of this candle: a desk showing H4 is fed
   // H4 bars by an M15 chart. Without this the engine would keep
   // rewriting the chart's timeframe to whatever the desk last looked
   // at, and the chart list would flicker between the two.
   json += "\"chart_timeframe\":\"" + TfName(_Period) + "\",";
   json += "\"time\":\"" + IsoTime(t) + "\",";
   json += "\"time_msc\":" + IntegerToString((long)t * 1000) + ",";
   json += "\"open\":" + DoubleToString(iOpen(_Symbol, use, shift), _Digits) + ",";
   json += "\"high\":" + DoubleToString(iHigh(_Symbol, use, shift), _Digits) + ",";
   json += "\"low\":" + DoubleToString(iLow(_Symbol, use, shift), _Digits) + ",";
   json += "\"close\":" + DoubleToString(iClose(_Symbol, use, shift), _Digits) + ",";
   json += "\"volume\":" + DoubleToString((double)iVolume(_Symbol, use, shift), 0) + ",";
   json += "\"closed\":" + (shift > 0 ? "true" : "false") + ",";
   json += TapeTag();
   json += "}";
   SendRaw(json);
  }

/* The chart's own timeframe, which every existing caller means. */
void SendCandle(const int shift)
  {
   SendCandleOn(_Period, shift);
   // The desk's timeframe too, when it differs - this is what keeps a
   // chart the trader switched to inside AURION alive.
   if(g_feed_tf != PERIOD_CURRENT && g_feed_tf != _Period)
      SendCandleOn(g_feed_tf, shift);
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

void QueueHistory(const string tfName, const int want)
  {
   if(tfName != "")
     {
      // The engine only ever asks for history for the timeframe the
      // desk is showing, so this is also the answer to "what is the
      // trader looking at" - and it is the only thing in the protocol
      // that says so. Remember it, and feed it live from now on.
      ENUM_TIMEFRAMES want_tf = PeriodFromName(tfName);
      if(want_tf != g_feed_tf)
        {
         g_feed_tf = want_tf;
         g_feed_bar = 0;
        }
     }
   g_hist_tfname = tfName;
   g_hist_want = want;
   g_hist_pos = 0;
   g_hist_count = 0;
   g_hist_tries = 0;
   g_hist_next = 0;
   // Every request starts from "what have we got" again. A new request
   // can be for a different timeframe, and carrying the previous
   // phase - or the count it delivered - over would make phase two
   // judge this series against the last one's.
   g_hist_phase = 0;
   g_hist_sent = 0;
   ArrayFree(g_hist_rates);
  }

/* What this terminal holds on a timeframe, as JSON fields.
 *
 * SERIES_BARS_COUNT is what MetaTrader has in memory for the series
 * and SERIES_FIRSTDATE is the oldest bar in it. Both are facts about
 * the TERMINAL, not about the broker's archive, which is exactly the
 * distinction a trader cannot make by looking at a short chart. */
string HistoryDepthTag(const ENUM_TIMEFRAMES tf, const int requested)
  {
   long have = SeriesInfoInteger(_Symbol, tf, SERIES_BARS_COUNT);
   datetime oldest = (datetime)SeriesInfoInteger(_Symbol, tf, SERIES_FIRSTDATE);
   string json = "\"requested\":" + IntegerToString(requested) + ",";
   json += "\"available\":" + IntegerToString((int)have) + ",";
   json += "\"oldest\":\"" + (oldest > 0 ? IsoTime(oldest) : "") + "\",";
   return json;
  }

/* The reply that used to be silence.
 *
 * When CopyRates never comes good the request simply stopped, and the
 * desk had no way to tell "the terminal has nothing here" from "the
 * bridge died". A final, empty answer carrying the depth facts says
 * which it is. */
void SendHistoryShortfall(const int requested)
  {
   string json = "{\"type\":\"candles\"," + TapeTag() + ",\"symbol\":\"" + JsonEsc(_Symbol) + "\",";
   json += "\"timeframe\":" + IntegerToString(PeriodSeconds(g_hist_tf) / 60) + ",";
   json += "\"timeframe_name\":\"" + TfName(g_hist_tf) + "\",";
   json += "\"replace\":false,";
   json += "\"final\":true,";
   json += HistoryDepthTag(g_hist_tf, requested);
   json += "\"bars\":[]}";
   SendRaw(json);
   Print("AURION: no history for ", _Symbol, " ", TfName(g_hist_tf),
         " after ", AURION_HIST_TRIES, " attempts - the terminal holds ",
         SeriesInfoInteger(_Symbol, g_hist_tf, SERIES_BARS_COUNT), " bars");
  }

/* The depth this request is for, clamped once rather than in three
 * places that could drift apart. */
int HistDepth()
  {
   int depth = (g_hist_want > 0 ? g_hist_want : InpCandleDepth);
   if(depth < 50) depth = 50;
   if(depth > AURION_HIST_MAX) depth = AURION_HIST_MAX;
   return depth;
  }

/* History, in two answers rather than one.
 *
 * 1.21 asked only for a date RANGE, because that is the form that makes
 * MetaTrader download a period it does not hold - and that part was
 * right, it is how six months arrive at all. What it got wrong is that
 * a range the terminal has no series for is answered -1 while the
 * download runs. On a timeframe this chart has never been opened on
 * that is EVERY attempt for up to a minute and a half, and the engine
 * gives up after eight to twenty-five seconds. The desk was left with
 * an empty chart unless the trader went into MetaTrader and put the
 * chart on the same timeframe by hand - which is exactly what was
 * reported.
 *
 * So the answer is split in two:
 *
 *   phase 0  CopyRates(sym, tf, 0, depth) - whatever series this
 *            terminal has already built. It comes back at once, and
 *            the act of asking is also what makes the terminal start
 *            building a series it does not have, so the desk gets a
 *            chart on any timeframe within a second. It is marked
 *            final, so the waiting request is answered instead of
 *            timing out.
 *
 *   phase 1  the date range, on the old widening ladder. When it
 *            lands with MORE bars than phase 0 sent, the whole stream
 *            is re-sent with replace:true and the desk swaps the
 *            short chart for the deep one. If the broker will not
 *            serve the period, the phase 0 bars stay on screen and
 *            nothing has been lost.
 */
void PumpHistory()
  {
   if(g_hist_pos < 0)
      return;
   if(g_hist_count <= 0 && g_hist_next > 0 && GetTickCount() < g_hist_next)
      return;   // waiting out the backoff between CopyRates attempts
   if(g_hist_count <= 0)
     {
      g_hist_tf = (g_hist_tfname == "" ? _Period : PeriodFromName(g_hist_tfname));
      // The engine names the depth it needs, because only the engine
      // knows the window the product promises and which timeframe the
      // trader is on. The old code ignored it and clamped to 400 bars,
      // so the desk got six hours of M1 and called it a month.
      int depth = HistDepth();
      ArraySetAsSeries(g_hist_rates, false);

      if(g_hist_phase == 0)
        {
         int held = CopyRates(_Symbol, g_hist_tf, 0, depth, g_hist_rates);
         if(held > 0)
           {
            g_hist_count = held;
            g_hist_pos = 0;
            g_hist_tries = 0;
            g_hist_next = 0;
           }
         else
           {
            // Nothing built yet for this timeframe. Touching the series
            // is what schedules the terminal's own fetch, and a few
            // short waits are worth it because this is the answer that
            // puts a chart on screen.
            g_hist_tries++;
            SeriesInfoInteger(_Symbol, g_hist_tf, SERIES_BARS_COUNT);
            if(g_hist_tries <= AURION_HIST_QUICK_TRIES)
              {
               uint qwait = (uint)(120 * g_hist_tries);
               if(qwait > 1000) qwait = 1000;
               g_hist_next = GetTickCount() + qwait;
               return;
              }
            // Still nothing on hand. The range form is the one that
            // downloads, so go straight to it.
            g_hist_phase = 1;
            g_hist_tries = 0;
            g_hist_next = 0;
            return;
           }
        }
      else
        {
         /* Ask for a PERIOD, not for a position.
          *
          * CopyRates(symbol, tf, 0, depth, rates) is answered out of
          * the series this terminal has already built - that is phase
          * 0 above - and nothing in that call ever makes the terminal
          * go to the broker for the rest. The date form is a request
          * for a time RANGE, and a range the terminal does not hold is
          * what makes it download. That is the whole of "MetaTrader
          * shows me months and AURION does not".
          *
          * The range is the depth expressed in time, because that is
          * what the depth was converted FROM: the engine sizes it as
          * calendar days divided by the bar length. Going back
          * depth x PeriodSeconds therefore asks for the same calendar
          * window, and the weekends inside it simply come back empty. */
         datetime stop  = TimeCurrent() + PeriodSeconds(g_hist_tf);
         datetime begin = (datetime)((long)stop - (long)PeriodSeconds(g_hist_tf) * (long)depth);
         if((long)begin < 0) begin = 0;
         int n = CopyRates(_Symbol, g_hist_tf, begin, stop, g_hist_rates);
         if(n > g_hist_sent)
           {
            g_hist_count = n;
            g_hist_pos = 0;
            g_hist_tries = 0;
            g_hist_next = 0;
           }
         else
           {
            // MetaTrader answers -1 while it is still fetching, which
            // is the normal first answer for a period it does not
            // hold. Asking again is what finishes the download, so ask
            // again - on a widening delay, and not forever.
            g_hist_tries++;
            if(g_hist_tries <= AURION_HIST_TRIES)
              {
               SeriesInfoInteger(_Symbol, g_hist_tf, SERIES_BARS_COUNT);
               uint wait = (uint)(250 * g_hist_tries);
               if(wait > 3000) wait = 3000;
               g_hist_next = GetTickCount() + wait;
               return;
              }
            if(g_hist_sent > 0)
              {
               // Out of patience, but not out of history: the desk is
               // already drawing the bars this terminal holds, which
               // is what the trader can see on their own chart. Say
               // which it is, and leave that chart alone.
               Print("AURION: ", _Symbol, " ", TfName(g_hist_tf),
                     " - the broker would not serve the whole period; the desk keeps the ",
                     g_hist_sent, " bars this terminal holds");
               g_hist_pos = -1;
               g_hist_count = 0;
               g_hist_tries = 0;
               g_hist_next = 0;
               ArrayFree(g_hist_rates);
               return;
              }
            // Nothing anywhere. Say so rather than going quiet: an
            // empty final reply releases the desk to draw what it has
            // and lets it tell the trader the terminal holds no
            // history here, which is a different problem from a bridge
            // that stopped answering.
            SendHistoryShortfall(depth);
            g_hist_pos = -1;
            g_hist_tries = 0;
            g_hist_next = 0;
            return;
           }
        }
     }
   int start = g_hist_pos;
   int endd = start + AURION_HIST_CHUNK;
   if(endd > g_hist_count) endd = g_hist_count;
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   string json = "{\"type\":\"candles\"," + TapeTag() + ",\"symbol\":\"" + JsonEsc(_Symbol) + "\",";
   json += "\"timeframe\":" + IntegerToString(PeriodSeconds(g_hist_tf) / 60) + ",";
   json += "\"timeframe_name\":\"" + TfName(g_hist_tf) + "\",";
   json += "\"chart_timeframe\":\"" + TfName(_Period) + "\",";
   json += "\"replace\":" + (start == 0 ? "true" : "false") + ",";
   json += "\"final\":" + (endd >= g_hist_count ? "true" : "false") + ",";
   if(endd >= g_hist_count)
     {
      // What this terminal actually holds, said once at the end of the
      // stream. A chart that stops three weeks back is either the
      // broker's limit or the terminal's "Max bars in chart" setting,
      // and a trader cannot tell those apart from a short chart alone.
      // Sending the count and the oldest date lets the desk name the
      // cause instead of silently drawing less than it promised.
      json += HistoryDepthTag(g_hist_tf, (g_hist_want > 0 ? g_hist_want : InpCandleDepth));
     }
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
      int streamed = g_hist_count;
      g_hist_pos = -1;
      g_hist_count = 0;
      ArrayFree(g_hist_rates);
      if(g_hist_phase == 0)
        {
         g_hist_sent = streamed;
         // The desk has a chart now. If it is shallower than what was
         // asked for, go and fetch the rest as a period: that download
         // can take a minute, and nothing is waiting on it any more.
         if(streamed < HistDepth())
           {
            g_hist_phase = 1;
            g_hist_pos = 0;
            g_hist_tries = 0;
            g_hist_next = GetTickCount() + 50;
           }
        }
     }
  }

void SendSpec()
  {
//--- What one tick of this symbol is worth.
//
//  Without it the engine can price a stop in points and nothing else,
//  and "no stop may cost more than ten dollars a lot" cannot be
//  enforced at all. The terminal knows; it simply was never asked.
//  Sent on attach and refreshed slowly, because a contract
//  specification changes about as often as the broker does.
   string json = "{";
   json += "\"type\":\"spec\",";
   json += "\"symbol\":\"" + JsonEsc(_Symbol) + "\",";
   json += "\"digits\":" + IntegerToString((int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS)) + ",";
   json += "\"point\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_POINT), 8) + ",";
   json += "\"tick_size\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE), 8) + ",";
   json += "\"tick_value\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE), 8) + ",";
   json += "\"tick_value_loss\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE_LOSS), 8) + ",";
   json += "\"contract_size\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_TRADE_CONTRACT_SIZE), 2) + ",";
   json += "\"volume_min\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN), 2) + ",";
   json += "\"volume_step\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP), 2) + ",";
   json += "\"volume_max\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX), 2) + ",";
   json += "\"stops_level\":" + IntegerToString((int)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL)) + ",";
   json += "\"currency\":\"" + JsonEsc(SymbolInfoString(_Symbol, SYMBOL_CURRENCY_PROFIT)) + "\",";
   json += TapeTag();
   json += "}";
   SendRaw(json);
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
      json += "\"price\":" + DoubleToString(OrderGetDouble(ORDER_PRICE_OPEN), _Digits) + ",";
      json += "\"sl\":" + DoubleToString(OrderGetDouble(ORDER_SL), _Digits) + ",";
      json += "\"tp\":" + DoubleToString(OrderGetDouble(ORDER_TP), _Digits) + ",";
      json += "\"magic\":" + IntegerToString(OrderGetInteger(ORDER_MAGIC)) + ",";
      // The desk expires its own resting orders, which it cannot do without
      // knowing when each one was placed.
      json += "\"time\":\"" + TimeToString((datetime)OrderGetInteger(ORDER_TIME_SETUP), TIME_DATE|TIME_SECONDS) + "\",";
      json += "\"comment\":\"" + JsonEsc(OrderGetString(ORDER_COMMENT)) + "\"";
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
   if(type == "pending") { TradePending(line); return; }
   if(type == "cancel") { TradeCancel(line); return; }
   if(type == "close") { TradeClose(line); return; }
   if(type == "modify") { TradeModify(line); return; }
   if(type == "flatten") { Flatten(); return; }
   if(type == "request_history")
     {
      string want = Extract(line, "symbol");
      if(want != "" && !SameSymbol(want, _Symbol)) return;
      string tf = Extract(line, "timeframe_name");
      if(tf == "") tf = Extract(line, "timeframe");
      QueueHistory(tf, (int)StringToInteger(Extract(line, "count")));
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

// A resting order at a price the robot chose, with the stop and target
// already attached. The trade only starts if the market comes back to it,
// which is the whole point: no burst of market orders on the candle close,
// and the entry is paid at the level rather than at whatever the impulse
// candle happened to leave behind.
void TradePending(const string line)
  {
   string want = Extract(line, "symbol");
   if(want != "" && !SameSymbol(want, _Symbol)) return;
   if(g_tester) { Reply(false, "tester tape is read-only - live orders stay on the main chart"); return; }
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) { Reply(false, "terminal AutoTrading is OFF"); return; }
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) { Reply(false, "AutoTrading is OFF on this chart"); return; }
   string kind = Extract(line, "order_type");
   StringToLower(kind);
   double volume = StringToDouble(Extract(line, "volume"));
   double price  = StringToDouble(Extract(line, "price"));
   double sl = StringToDouble(Extract(line, "sl"));
   double tp = StringToDouble(Extract(line, "tp"));
   if(volume <= 0) { Reply(false, "volume required"); return; }
   if(price <= 0)  { Reply(false, "price required for a pending order"); return; }
   MqlTradeRequest req;
   MqlTradeResult res;
   ZeroMemory(req);
   ZeroMemory(res);
   req.action = TRADE_ACTION_PENDING;
   req.symbol = _Symbol;
   req.volume = volume;
   req.price = NormalizeDouble(price, _Digits);
   req.deviation = 30;
   req.magic = 908173;
   req.type_time = ORDER_TIME_GTC;
   req.type_filling = FillOf(_Symbol);
   string cmt = Extract(line, "comment");
   if(cmt == "") cmt = "AURION";
   if(StringLen(cmt) > 31) cmt = StringSubstr(cmt, 0, 31);
   req.comment = cmt;
   if(kind == "sell_limit")      req.type = ORDER_TYPE_SELL_LIMIT;
   else if(kind == "sell_stop")  req.type = ORDER_TYPE_SELL_STOP;
   else if(kind == "buy_stop")   req.type = ORDER_TYPE_BUY_STOP;
   else                          req.type = ORDER_TYPE_BUY_LIMIT;
   if(sl > 0.0) req.sl = NormalizeDouble(sl, _Digits);
   if(tp > 0.0) req.tp = NormalizeDouble(tp, _Digits);
   bool ok = OrderSend(req, res);
   bool good = ok && (res.retcode == TRADE_RETCODE_DONE || res.retcode == TRADE_RETCODE_PLACED);
   Reply(good, "retcode=" + IntegerToString(res.retcode) + " " + res.comment);
   if(good) SendOrders();
  }

// The desk cancels a resting order that waited too long. Only its own:
// the magic number is checked engine-side before the ticket is sent.
void TradeCancel(const string line)
  {
   ulong ticket = (ulong)StringToInteger(Extract(line, "ticket"));
   if(ticket == 0) { Reply(false, "ticket required"); return; }
   if(!OrderSelect(ticket)) { Reply(false, "order not found"); return; }
   MqlTradeRequest req;
   MqlTradeResult res;
   ZeroMemory(req);
   ZeroMemory(res);
   req.action = TRADE_ACTION_REMOVE;
   req.order = ticket;
   bool ok = OrderSend(req, res);
   Reply(ok && (res.retcode == TRADE_RETCODE_DONE || res.retcode == TRADE_RETCODE_PLACED),
         "retcode=" + IntegerToString(res.retcode));
   SendOrders();
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
