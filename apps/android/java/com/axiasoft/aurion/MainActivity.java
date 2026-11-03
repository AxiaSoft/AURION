package com.axiasoft.aurion;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.Locale;

/**
 * A window onto the AURION desk running on the trader's own machine.
 *
 * The APK deliberately carries no desk and no market data. The backend on
 * the PC already serves apps/web and proxies /api to the Python engine, so
 * pointing a WebView at it gives the real desk — live prices, the EA, the
 * journal — rather than a copy that could drift out of step with it.
 *
 * Everything the desk needs from a browser it gets here: JavaScript, DOM
 * storage (the desk keeps theme, language and layout in localStorage) and
 * autoplaying media for the welcome clip. What it does not get is a secure
 * context, because a LAN address cannot have a certificate: the service
 * worker registration in app.js is guarded by `"serviceWorker" in navigator`
 * and a .catch(), so it simply does not run. Nothing else depends on it.
 */
public class MainActivity extends Activity {

  private static final String PREFS = "aurion";
  private static final String KEY_URL = "desk_url";

  /** The backend's default port. The engine's own 18765 is not what we want:
   *  the backend is the one that serves the HTML and proxies the API, and
   *  going through it keeps every request same-origin. */
  private static final String DEFAULT_PORT = "8080";

  private WebView web;
  private String deskUrl = "";
  private boolean failed = false;

  // --- lifecycle ----------------------------------------------------------

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      getWindow().setStatusBarColor(Color.parseColor("#06070b"));
    }
    deskUrl = prefs().getString(KEY_URL, "");
    if (deskUrl.length() == 0) {
      showSetup(null);
    } else {
      showDesk();
    }
  }

  @Override
  protected void onDestroy() {
    disposeWeb();
    super.onDestroy();
  }

  @Override
  public void onBackPressed() {
    if (web == null) {       // already on the setup screen
      finish();
      return;
    }
    if (!failed && web.canGoBack()) {
      web.goBack();
      return;
    }
    new AlertDialog.Builder(this)
        .setTitle(tr("AURION", "AURION"))
        .setMessage(tr("Leave the desk, or point it at another address?",
                       "از دسک خارج می‌شوید، یا به آدرس دیگری وصلش کنیم؟"))
        .setPositiveButton(tr("Change address", "تغییر آدرس"),
            new DialogInterface.OnClickListener() {
              public void onClick(DialogInterface d, int which) { showSetup(null); }
            })
        .setNegativeButton(tr("Close", "بستن"),
            new DialogInterface.OnClickListener() {
              public void onClick(DialogInterface d, int which) { finish(); }
            })
        .setNeutralButton(tr("Stay", "ماندن"), null)
        .show();
  }

  // --- the desk -----------------------------------------------------------

  private void showDesk() {
    disposeWeb();
    failed = false;

    web = new WebView(this);
    web.setBackgroundColor(Color.parseColor("#06070b"));
    web.setKeepScreenOn(true);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    // The desk ships its own viewport meta and is responsive down to 375px;
    // let it decide its width instead of emulating a desktop one.
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setDisplayZoomControls(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    // The welcome clip is muted and inline; without this it never starts.
    s.setMediaPlaybackRequiresUserGesture(false);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
      WebView.setWebContentsDebuggingEnabled(true);
    }

    web.setWebChromeClient(new WebChromeClient());
    web.setWebViewClient(new WebViewClient() {

      @Override
      public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return external(url);
      }

      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return external(request.getUrl() == null ? "" : request.getUrl().toString());
      }

      /** Pre-23 devices still call this one. */
      @Override
      public void onReceivedError(WebView view, int code, String description, String failingUrl) {
        if (failingUrl != null && failingUrl.startsWith(deskUrl)) {
          showSetup(description);
        }
      }

      @Override
      public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        // A failed image or favicon must not throw the trader back to a
        // setup screen; only the page itself failing to arrive counts.
        if (!request.isForMainFrame()) return;
        showSetup(error == null ? null : String.valueOf(error.getDescription()));
      }
    });

    setContentView(web, new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    web.loadUrl(deskUrl);
  }

  /** Links that leave the desk open in a real browser rather than trapping
   *  the trader inside a window with no address bar. */
  private boolean external(String url) {
    if (url == null || url.length() == 0) return false;
    if (url.startsWith(deskUrl)) return false;
    if (url.startsWith("http://") || url.startsWith("https://")
        || url.startsWith("tg:") || url.startsWith("mailto:")) {
      try {
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        return true;
      } catch (Exception ignored) {
        return false;
      }
    }
    return false;
  }

  private void disposeWeb() {
    if (web == null) return;
    web.stopLoading();
    web.setWebChromeClient(null);
    ViewGroup parent = (ViewGroup) web.getParent();
    if (parent != null) parent.removeView(web);
    web.destroy();
    web = null;
  }

  // --- the setup screen ---------------------------------------------------

  private void showSetup(String problem) {
    disposeWeb();
    failed = true;

    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    box.setGravity(Gravity.CENTER_VERTICAL);
    box.setBackgroundColor(Color.parseColor("#06070b"));
    int pad = dp(24);
    box.setPadding(pad, pad, pad, pad);

    TextView title = new TextView(this);
    title.setText("AURION");
    title.setTextColor(Color.parseColor("#e9edf5"));
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
    title.setLetterSpacing(0.18f);
    box.addView(title);

    TextView blurb = new TextView(this);
    blurb.setText(tr(
        "Enter the address of the machine running the AURION desk. "
        + "Both devices must be on the same network.",
        "آدرس دستگاهی را وارد کنید که دسک AURION روی آن در حال اجراست. "
        + "هر دو دستگاه باید روی یک شبکه باشند."));
    blurb.setTextColor(Color.parseColor("#8a93a6"));
    blurb.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
    blurb.setPadding(0, dp(10), 0, dp(18));
    box.addView(blurb);

    if (problem != null && problem.length() > 0) {
      TextView bad = new TextView(this);
      bad.setText(tr("Could not reach the desk: ", "دسک در دسترس نبود: ") + problem);
      bad.setTextColor(Color.parseColor("#f4475b"));
      bad.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
      bad.setPadding(0, 0, 0, dp(14));
      box.addView(bad);
    }

    final EditText field = new EditText(this);
    field.setHint("192.168.1.20:" + DEFAULT_PORT);
    field.setHintTextColor(Color.parseColor("#5c6478"));
    field.setTextColor(Color.parseColor("#e9edf5"));
    field.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
    field.setSingleLine(true);
    field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    field.setText(prefs().getString(KEY_URL, ""));
    // The address is Latin even when the interface is Persian.
    field.setTextDirection(View.TEXT_DIRECTION_LTR);
    box.addView(field);

    Button go = new Button(this);
    go.setText(tr("Connect", "اتصال"));
    go.setAllCaps(false);
    go.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
    LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    gp.topMargin = dp(20);
    go.setLayoutParams(gp);
    go.setOnClickListener(new View.OnClickListener() {
      public void onClick(View v) {
        String url = normalise(field.getText().toString());
        if (url.length() == 0) return;
        deskUrl = url;
        prefs().edit().putString(KEY_URL, url).apply();
        showDesk();
      }
    });
    box.addView(go);

    TextView hint = new TextView(this);
    hint.setText(tr(
        "On the PC, run the desk and find its address with ipconfig. "
        + "Port " + DEFAULT_PORT + " is assumed unless you give another, "
        + "and the PC firewall has to allow it.",
        "روی کامپیوتر دسک را اجرا کنید و آدرسش را با ipconfig پیدا کنید. "
        + "اگر پورتی ننویسید " + DEFAULT_PORT + " فرض می‌شود، "
        + "و فایروال کامپیوتر هم باید اجازه‌اش را بدهد."));
    hint.setTextColor(Color.parseColor("#5c6478"));
    hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
    hint.setPadding(0, dp(22), 0, 0);
    box.addView(hint);

    ScrollView scroll = new ScrollView(this);
    scroll.setBackgroundColor(Color.parseColor("#06070b"));
    scroll.setFillViewport(true);
    scroll.addView(box, new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    setContentView(scroll);
  }

  // --- helpers ------------------------------------------------------------

  /**
   * Turns what a human types into a URL the WebView can load.
   *
   * "192.168.1.20" becomes "http://192.168.1.20:8080". A scheme, a port or a
   * path that the trader supplied is kept exactly as given; only what is
   * missing is filled in, so an unusual deployment is never overridden.
   */
  static String normalise(String raw) {
    String s = raw == null ? "" : raw.trim();
    if (s.length() == 0) return "";

    String scheme = "http";
    int mark = s.indexOf("://");
    if (mark > 0) {
      scheme = s.substring(0, mark).toLowerCase(Locale.US);
      s = s.substring(mark + 3);
    }

    String hostPort = s;
    String path = "";
    int slash = s.indexOf('/');
    if (slash >= 0) {
      hostPort = s.substring(0, slash);
      path = s.substring(slash);
    }
    if (hostPort.length() == 0) return "";

    int colon = hostPort.indexOf(':');
    // ":8080" or "://foo" leave nothing to connect to. Rejecting them here
    // returns the trader to the field with the address still editable,
    // instead of handing the WebView a URL that fails for an obscure reason.
    String hostOnly = colon < 0 ? hostPort : hostPort.substring(0, colon);
    if (hostOnly.length() == 0) return "";

    // A bare host gets the backend's port. Anything with a colon already
    // carries its own, so leave it be, and someone who typed "https" is
    // describing a real deployment with a certificate, where forcing 8080
    // instead of 443 would override a deliberate choice.
    if (colon < 0 && "http".equals(scheme)) {
      hostPort = hostPort + ":" + DEFAULT_PORT;
    }

    while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
    return scheme + "://" + hostPort + path;
  }

  private SharedPreferences prefs() {
    return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private int dp(int value) {
    return (int) TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
  }

  /** Persian when the phone is Persian, English otherwise. */
  private String tr(String en, String fa) {
    return "fa".equals(Locale.getDefault().getLanguage()) ? fa : en;
  }
}
