/* The prop guide, inside the prop page.
 *
 * It used to live in a separate HTML document, which meant the one moment
 * you need it — a box in front of you asking for a number — is the one
 * moment it is not on screen. So the text sits under the form, one entry
 * per control, in the same order as the controls themselves, and each
 * entry says what the setting does, what the number means and what a
 * sensible value looks like.
 *
 * Rules for anything added here:
 *   - every control in propFormHtml()/propStatusHtml() gets an entry, and
 *     tests/prop-guide.test.js fails the build if one is missing;
 *   - no instrument is ever named. A rule about spread or volatility is
 *     stated as a principle, because the right number depends on the
 *     symbol, the broker and the session, and a named example gets copied
 *     by people trading something else;
 *   - Persian is the authored language, English is authored too, Arabic is
 *     the short form and falls back to English when absent.
 */
(function (root) {
  "use strict";

  const SECTIONS = [
    {
      id: "basics",
      title: { fa: "اول از همه: پراپ چه کار می‌کند", en: "First: what prop actually does", ar: "أولاً: ماذا يفعل البروب" },
      lede: {
        fa: "پراپ یک <b>فیلتر</b> روی همان سیگنال‌هاست، نه یک استراتژی جدا. استراتژی سیگنال می‌سازد و پراپ تصمیم می‌گیرد اجازهٔ ارسال بدهد یا نه. پس اگر معامله‌ای باز نمی‌شود، یا استراتژی سیگنالی نداده یا یکی از همین قانون‌ها جلویش را گرفته — و در هر دو حالت دلیلش نوشته می‌شود.",
        en: "Prop is a <b>filter</b> over the same signals, not a separate strategy. The strategy produces a signal and prop decides whether it may be sent. So when nothing opens, either the strategy had no setup or one of these rules stopped it — and in both cases the reason is written down.",
        ar: "البروب مرشّح على الإشارات نفسها وليس استراتيجية منفصلة. الاستراتيجية تُنتج الإشارة والبروب يسمح أو يمنع."
      },
      rows: [
        {
          id: "prop-enable",
          label: { fa: "کلید روشن/خاموش پراپ", en: "The prop switch", ar: "مفتاح البروب" },
          fa: "خاموش یعنی هیچ‌کدام از قانون‌های این صفحه اعمال نمی‌شود؛ فقط محافظ‌های عمومی حساب می‌مانند. برای حساب چلنج یا فاندد همیشه روشن.",
          en: "Off means none of the rules on this page apply; only the general account guards remain. For a challenge or a funded account, leave it on.",
          ar: "الإيقاف يعني إلغاء كل قواعد هذه الصفحة. أبقه مُشغّلاً في حساب التحدي أو الممول."
        },
        {
          id: "pr-lock",
          label: { fa: "قفل دستی", en: "Lock", ar: "القفل" },
          fa: "فوراً ورود جدید را می‌بندد و وضعیت را «قفل» می‌کند. معامله‌های باز را نمی‌بندد؛ برای بستن از کلید اضطراری استفاده کنید.",
          en: "Closes the door to new entries at once and marks the desk locked. It does not close open trades; the emergency switch does that.",
          ar: "يمنع الدخول الجديد فوراً ولا يغلق الصفقات المفتوحة."
        },
        {
          id: "pr-unlock",
          label: { fa: "باز کردن قفل", en: "Unlock", ar: "فتح القفل" },
          fa: "قفل را برمی‌دارد و شمارنده‌های روز را دست نمی‌زند. اگر همان قانون هنوز نقض است، دوباره بلافاصله قفل می‌شود — این ایراد نیست، یعنی هنوز خارج از قانون هستید.",
          en: "Lifts the lock and leaves the day's counters alone. If the same rule is still broken it locks again immediately — that is not a fault, it means you are still outside the rule.",
          ar: "يرفع القفل دون تصفير العدادات. إذا بقيت المخالفة يعود القفل فوراً."
        },
        {
          id: "pr-preset",
          label: { fa: "پروفایل آماده", en: "Preset profile", ar: "الملف الجاهز" },
          fa: "یک‌جا همهٔ عددهای پایین را روی قانون‌های یک شرکت می‌گذارد. <b>conservative</b> سخت‌گیرترین است و برای فاز ارزیابی مناسب. اگر شرکت شما در فهرست نیست، <b>custom</b> را بگیرید و عددها را از روی قرارداد خودتان وارد کنید — قانون شرکت همیشه مرجع است، نه این فهرست.",
          en: "Sets every number below at once to one firm's rulebook. <b>conservative</b> is the strictest and the right choice for an evaluation. If your firm is not listed, pick <b>custom</b> and copy the numbers from your own contract — the contract is the authority, not this list.",
          ar: "يضبط كل الأرقام دفعة واحدة. <b>conservative</b> هو الأصرم. إن لم تكن شركتك مدرجة فاختر <b>custom</b>."
        }
      ]
    },
    {
      id: "limits",
      title: { fa: "سقف‌های ضرر و حجم", en: "Loss and size limits", ar: "حدود الخسارة والحجم" },
      lede: {
        fa: "این بخش همان چیزی است که حساب را می‌سوزاند یا نجات می‌دهد. همهٔ درصدها نسبت به <b>بالانس</b> ابتدای روز حساب می‌شوند، مگر جایی که «اکوییتی» نوشته شده باشد.",
        en: "This is the part that burns an account or saves it. Every percentage is measured against the <b>balance</b> at the start of the day, except where the field says equity.",
        ar: "النسب تُقاس على رصيد بداية اليوم إلا حيث يُذكر حقوق الملكية."
      },
      rows: [
        {
          id: "pr-dday",
          label: { fa: "حد ضرر روزانه", en: "Daily loss", ar: "خسارة اليوم" },
          fa: "درصدی از بالانس که اگر امروز از دست برود، میز تا پایان روز بسته می‌شود. معمولاً شرکت‌ها بین ۴ تا ۵ درصد می‌دهند؛ عدد خودتان را یک پله <b>پایین‌تر</b> از قرارداد بگذارید تا اسپرد و سوآپ شما را از مرز رد نکند. مثال: قرارداد ۵٪ ⇒ اینجا ۴٪.",
          en: "The share of balance that, once lost today, closes the desk until tomorrow. Firms usually allow four to five per cent; set yours one notch <b>below</b> the contract so that spread and swap cannot push you over the line. Contract says 5% ⇒ put 4% here.",
          ar: "النسبة التي يُغلق عندها اليوم. اجعلها أقل قليلاً مما ينص عليه العقد."
        },
        {
          id: "pr-mdd",
          label: { fa: "حداکثر افت سرمایه", en: "Max drawdown", ar: "أقصى تراجع" },
          fa: "سقف کل افت حساب از بالاترین نقطه‌اش. این یکی برخلاف حد روزانه با شروع روز جدید صفر نمی‌شود؛ رسیدن به آن یعنی پایان چلنج. نوار رنگی بالای صفحه همین عدد را نشان می‌دهد.",
          en: "The ceiling on the whole account's fall from its highest point. Unlike the daily limit it does not reset with a new day; reaching it ends the challenge. The coloured bar at the top of the page tracks this number.",
          ar: "سقف تراجع الحساب من أعلى نقطة، ولا يُصفَّر يومياً."
        },
        {
          id: "pr-dtp",
          label: { fa: "سقف سود روزانه", en: "Daily profit cap", ar: "سقف ربح اليوم" },
          fa: "وقتی سود امروز به این درصد برسد، میز داوطلبانه تعطیل می‌شود. ۰ یعنی بدون سقف. این قانون شرکت نیست، انضباط است: بیشترین ضررها بعد از بهترین ساعت روز اتفاق می‌افتد.",
          en: "When today's profit reaches this percentage the desk shuts voluntarily. 0 means no cap. This is not a firm rule, it is discipline: the worst losses tend to follow the best hour of the day.",
          ar: "إيقاف اختياري عند بلوغ ربح اليوم هذه النسبة. 0 يعني بلا سقف."
        },
        {
          id: "pr-pt",
          label: { fa: "هدف سود دوره", en: "Profit target", ar: "هدف الربح" },
          fa: "هدف کل فاز (مثلاً ۸٪ یا ۱۰٪ در چلنج). با رسیدن به آن میز می‌ایستد تا سود به‌دست‌آمده را با یک معاملهٔ اضافه پس ندهید. ۰ یعنی غیرفعال.",
          en: "The target for the whole phase (8% or 10% in a typical challenge). On reaching it the desk stops, so one extra trade cannot give the pass back. 0 disables it.",
          ar: "هدف المرحلة كاملة؛ عند بلوغه يتوقف المكتب. 0 يعطّله."
        },
        {
          id: "pr-lot",
          label: { fa: "حداکثر حجم هر معامله", en: "Max lot per trade", ar: "أقصى حجم للصفقة" },
          fa: "سقف مطلق لات برای یک سفارش. حتی اگر محاسبهٔ ریسک عدد بزرگ‌تری بدهد، همین‌جا بریده می‌شود. بسیاری از شرکت‌ها سقف لات دارند و رد شدن از آن، با سود هم، فاز را باطل می‌کند.",
          en: "A hard ceiling on one order's lot size. Even when the risk calculation asks for more, it is cut here. Many firms cap lot size, and breaching it voids the phase even on a winning trade.",
          ar: "سقف صارم لحجم الأمر الواحد مهما طلبت حسبة المخاطرة."
        },
        {
          id: "pr-lotsym",
          label: { fa: "حداکثر حجم هر نماد", en: "Max lot per symbol", ar: "أقصى حجم لكل رمز" },
          fa: "مجموع لات باز روی یک نماد. جلوی حالتی را می‌گیرد که سه معاملهٔ «کوچک» روی یک نماد در عمل یک پوزیشن بزرگ شده باشند. ۰ یعنی بدون محدودیت.",
          en: "The total open lot on a single symbol. It stops three \"small\" trades on one instrument from quietly adding up to one large position. 0 means no limit.",
          ar: "إجمالي اللوت المفتوح على رمز واحد. 0 بلا حد."
        },
        {
          id: "pr-n",
          label: { fa: "حداکثر معاملهٔ باز", en: "Max open trades", ar: "أقصى صفقات مفتوحة" },
          fa: "چند پوزیشن هم‌زمان مجاز است. در فاز ارزیابی عدد کم (۱ تا ۳) بهتر است: چند پوزیشن هم‌جهت در عمل یک معاملهٔ چندبرابری است و افت را با هم می‌سازند.",
          en: "How many positions may be open at once. A low number (one to three) suits an evaluation: several same-direction positions are really one multiplied trade, and they draw the account down together.",
          ar: "عدد الصفقات المتزامنة المسموح بها؛ الأفضل رقم صغير في مرحلة التقييم."
        },
        {
          id: "pr-ps",
          label: { fa: "حداکثر پوزیشن هر نماد", en: "Max positions per symbol", ar: "أقصى مراكز للرمز" },
          fa: "همان قانون بالا، محدود به یک نماد. ۱ یعنی روی هر نماد فقط یک معامله — ساده‌ترین راه برای اینکه مارتینگل ناخواسته اتفاق نیفتد.",
          en: "The same rule confined to one instrument. 1 means a single trade per symbol — the simplest protection against an accidental martingale.",
          ar: "نفس القاعدة لرمز واحد. 1 يعني صفقة واحدة فقط لكل رمز."
        },
        {
          id: "pr-dayn",
          label: { fa: "حداکثر معامله در روز", en: "Max trades per day", ar: "أقصى صفقات في اليوم" },
          fa: "شمارش معاملهٔ <b>باز شده</b> در روز، نه بسته‌شده. ۰ یعنی بدون محدودیت. برای جلوگیری از جبران‌کردن پشت‌سرهم بعد از یک ضرر، عددی بین ۳ تا ۵ کافی است.",
          en: "Counts trades <b>opened</b> today, not closed. 0 means no limit. Three to five is enough to stop a revenge sequence after a loss.",
          ar: "يحسب الصفقات المفتوحة اليوم. 0 بلا حد."
        },
        {
          id: "pr-risk",
          label: { fa: "ریسک هر معامله", en: "Risk per trade", ar: "مخاطرة الصفقة" },
          fa: "درصدی از <b>اکوییتی</b> که با فاصله تا حد ضرر، حجم را تعیین می‌کند. این عددی است که همه‌چیز از آن می‌آید: با ۰٫۵٪ ریسک، ده ضرر پشت‌سرهم حدود ۵٪ افت می‌سازد — یعنی دقیقاً لبهٔ همان حد افت بالا. اگر حد افت کم است، این را کم کنید، نه حد ضرر معامله را.",
          en: "The share of <b>equity</b> that, together with the stop distance, fixes the position size. Everything follows from this one number: at 0.5%, ten losses in a row cost about 5% — the very edge of the drawdown limit above. If the drawdown allowance is small, lower this, not the trade's stop.",
          ar: "نسبة حقوق الملكية التي تحدد الحجم مع مسافة الوقف؛ هي الرقم الأهم."
        }
      ]
    },
    {
      id: "time",
      title: { fa: "زمان، ساعت‌ها و خبر", en: "Time, hours and news", ar: "الوقت والساعات والأخبار" },
      lede: {
        fa: "ساعت‌ها به <b>ساعت انتخابی شما</b> در تنظیمات ← سیستم نوشته می‌شوند و زیر هر فیلد، همان لحظه به ساعت بروکر هم نشان داده می‌شود. قانون شرکت معمولاً به ساعت سرور بروکر نوشته شده، پس همان خط دوم را ملاک بگیرید.",
        en: "Hours are entered in <b>your chosen clock</b> from Settings → System, and the line under each field repeats the same instant on the broker's clock. A firm's rulebook is usually written in broker time, so judge by that second line.",
        ar: "تُدخل الساعات بتوقيتك المختار، ويظهر أسفل الحقل التوقيت المقابل لدى الوسيط."
      },
      rows: [
        {
          id: "pr-holdmin",
          label: { fa: "حداقل زمان نگهداری", en: "Minimum hold", ar: "أقل مدة احتفاظ" },
          fa: "معامله زودتر از این مدت بسته نمی‌شود. بعضی شرکت‌ها معاملهٔ زیر یک دقیقه را «اسکالپ ممنوع» حساب می‌کنند و سودش را حذف می‌کنند؛ اگر در قرارداد چنین بندی هست، همان عدد را اینجا بگذارید. ۰ یعنی بدون محدودیت.",
          en: "A trade will not be closed sooner than this. Some firms treat anything under a minute as banned scalping and strip its profit; if your contract has that clause, put its number here. 0 means no limit.",
          ar: "لا تُغلق الصفقة قبل هذه المدة. 0 بلا قيد."
        },
        {
          id: "pr-maxhold",
          label: { fa: "حداکثر زمان نگهداری", en: "Maximum hold", ar: "أقصى مدة احتفاظ" },
          fa: "بعد از این ساعت‌ها معامله بسته می‌شود، سود یا ضرر. برای پرهیز از سوآپ چندشبه و از پوزیشنی که فراموش شده. ۰ یعنی غیرفعال.",
          en: "After this many hours the trade is closed, in profit or not. It avoids multi-night swap and the position nobody remembers. 0 disables it.",
          ar: "تُغلق الصفقة بعد هذه الساعات ربحاً أو خسارة. 0 يعطّله."
        },
        {
          id: "pr-gap",
          label: { fa: "فاصله بین معامله‌ها", en: "Gap between trades", ar: "الفاصل بين الصفقات" },
          fa: "حداقل دقیقه بین دو ورود. ساده‌ترین ترمز در برابر ورودهای پشت‌سرهم روی یک حرکت؛ پنج سیگنال در پنج دقیقه در عمل یک معاملهٔ پنج‌برابری است.",
          en: "The least number of minutes between two entries. The simplest brake on stacking entries into one move; five signals in five minutes is one trade at five times the size.",
          ar: "أقل عدد دقائق بين دخولين، لمنع تكديس الصفقات."
        },
        {
          id: "pr-cl",
          label: { fa: "ضررهای پشت‌سرهم", en: "Consecutive losses", ar: "خسائر متتالية" },
          fa: "بعد از این تعداد ضرر پیاپی میز قفل می‌شود. ۰ یعنی غیرفعال. دو یا سه عدد متعارفی است؛ بیشتر ضررهای بزرگ، زنجیره‌ای از ضررهای کوچک‌اند که کسی جلویشان را نگرفته.",
          en: "The desk locks after this many losses in a row. 0 disables it. Two or three is usual; most large losses are a chain of small ones nobody interrupted.",
          ar: "يُقفل المكتب بعد هذا العدد من الخسائر المتتالية. 0 يعطّله."
        },
        {
          id: "pr-hs",
          label: { fa: "شروع ساعت معاملاتی", en: "Session start", ar: "بداية الجلسة" },
          fa: "پیش از این ساعت ورودی جدیدی باز نمی‌شود. اصل کار: ساعتی را انتخاب کنید که نماد مورد نظرتان نقدشوندگی دارد و اسپرد به حالت عادی برگشته — نه دقیقاً لحظهٔ باز شدن بازار که اسپرد پهن است.",
          en: "No new entry opens before this time. The principle: choose an hour when your instrument is liquid and the spread has settled — not the opening instant, when it is at its widest.",
          ar: "لا دخول قبل هذا الوقت؛ اختر ساعة سيولة واستقرار السبريد."
        },
        {
          id: "pr-he",
          label: { fa: "پایان ساعت معاملاتی", en: "Session end", ar: "نهاية الجلسة" },
          fa: "بعد از این ساعت ورود جدید ممنوع است. معاملهٔ باز بسته نمی‌شود مگر «حداکثر زمان نگهداری» بگوید. اگر پایان را زودتر از آخرین ساعت پرنوسان بگذارید، شب‌ها آرام‌تر می‌خوابید.",
          en: "No new entry after this time. An open trade stays open unless maximum hold says otherwise. Ending before the last volatile hour of your session makes for quieter nights.",
          ar: "لا دخول بعد هذا الوقت، والصفقة المفتوحة تبقى ما لم تحدد مدة قصوى."
        },
        {
          id: "pr-fri",
          label: { fa: "ساعت بستن جمعه", en: "Friday close hour", ar: "ساعة إغلاق الجمعة" },
          fa: "ساعت (به UTC) که جمعه‌ها همه‌چیز بسته و ورود متوقف می‌شود. تقریباً همهٔ شرکت‌ها نگه‌داشتن پوزیشن روی تعطیلات آخر هفته را ممنوع کرده‌اند و گپ یکشنبه‌شب جایی است که حساب‌ها یک‌شبه می‌سوزند.",
          en: "The hour (in UTC) at which Friday is flattened and entries stop. Nearly every firm forbids carrying a position over the weekend, and the Sunday gap is where accounts die overnight.",
          ar: "الساعة بتوقيت UTC التي تُغلق فيها صفقات الجمعة ويتوقف الدخول."
        },
        {
          id: "pr-nb",
          label: { fa: "قرنطینهٔ قبل از خبر", en: "News blackout before", ar: "الحظر قبل الخبر" },
          fa: "چند دقیقه پیش از رویداد تقویم، ورود ممنوع شود. فقط وقتی اثر دارد که «فیلتر خبر» تیک خورده باشد و فایل تقویم تنظیم شده باشد.",
          en: "Minutes before a calendar event in which no entry may open. It only has an effect when the news filter is ticked and a calendar file is configured.",
          ar: "دقائق المنع قبل الحدث، وتعمل فقط مع تفعيل مرشّح الأخبار."
        },
        {
          id: "pr-na",
          label: { fa: "قرنطینهٔ بعد از خبر", en: "News blackout after", ar: "الحظر بعد الخبر" },
          fa: "همان، بعد از رویداد. اگر شرکت شما بند «ممنوعیت معاملهٔ خبری» دارد، معمولاً هر دو عدد را دو برابر بندِ قرارداد بگذارید تا لحظهٔ مرزی هم پوشش داده شود.",
          en: "The same, after the event. If your firm has a news-trading clause, set both numbers to roughly twice the contract's window so the borderline minute is covered too.",
          ar: "نفس الشيء بعد الحدث؛ ضاعف المدة احتياطاً."
        }
      ]
    },
    {
      id: "filters",
      title: { fa: "فیلترها و واکنش به تخلف", en: "Filters and what happens on a breach", ar: "المرشّحات والاستجابة للمخالفة" },
      lede: {
        fa: "این بخش می‌گوید کجا معامله شود و وقتی قانونی شکست، میز چه کند.",
        en: "This part says where trading is allowed and what the desk does the moment a rule breaks.",
        ar: "هذا القسم يحدد أين يُسمح بالتداول وماذا يحدث عند المخالفة."
      },
      rows: [
        {
          id: "pr-syms",
          label: { fa: "نمادهای مجاز", en: "Allowed symbols", ar: "الرموز المسموحة" },
          fa: "اگر هیچ‌کدام انتخاب نشود یعنی همهٔ نمادها مجازند. انتخاب از فهرست زندهٔ بروکر خودتان انجام می‌شود، پس پسوندهای بروکر (مثل پسوند حساب‌های خاص) خودبه‌خود درست می‌مانند. نمادی را فعال نگه دارید که واقعاً دنبالش می‌کنید؛ فیلتر نماد ارزان‌ترین راه حذف معامله‌های بی‌ربط است.",
          en: "Selecting none means all symbols are allowed. The list comes from your own broker, so the broker's suffixes stay correct automatically. Keep only what you actually follow; the symbol filter is the cheapest way to delete trades you never meant to take.",
          ar: "عدم الاختيار يعني السماح بالجميع. القائمة من وسيطك نفسه فتبقى اللواحق صحيحة."
        },
        {
          id: "pr-vio",
          label: { fa: "رفتار هنگام تخلف", en: "On violation", ar: "عند المخالفة" },
          fa: "<b>lock</b> فقط ورود جدید را می‌بندد و معاملهٔ باز را به حال خود می‌گذارد. <b>flatten_and_lock</b> اول همه‌چیز را می‌بندد و بعد قفل می‌کند. برای حد ضرر روزانه و افت کل، گزینهٔ دوم درست است: قانون شرکت به اکوییتی لحظه‌ای نگاه می‌کند، نه به معاملهٔ بسته‌شده.",
          en: "<b>lock</b> only closes the door to new entries and leaves open trades alone. <b>flatten_and_lock</b> closes everything first, then locks. For a daily loss or a drawdown breach the second is the correct one: the firm's rule watches live equity, not closed trades.",
          ar: "<b>lock</b> يمنع الدخول فقط، و<b>flatten_and_lock</b> يغلق كل شيء ثم يقفل."
        },
        {
          id: "pr-news",
          label: { fa: "فیلتر خبر", en: "News filter", ar: "مرشّح الأخبار" },
          fa: "کلید اصلی دو فیلد قرنطینهٔ خبر. بدون فایل تقویم، تیک زدنش کاری نمی‌کند و همین را هم در دلیل‌ها می‌نویسد.",
          en: "The master switch for the two blackout fields. With no calendar file it does nothing, and says so in the reason line.",
          ar: "المفتاح الرئيسي لحقلي الحظر، ولا يعمل بلا ملف تقويم."
        },
        {
          id: "pr-we",
          label: { fa: "معاملهٔ آخر هفته", en: "Weekend trading", ar: "تداول نهاية الأسبوع" },
          fa: "فقط برای بازارهای ۲۴/۷ معنی دارد. برای حساب‌های پراپ معمولی خاموش بماند.",
          en: "Only meaningful on markets that trade around the clock all week. On an ordinary prop account, leave it off.",
          ar: "مفيد فقط للأسواق التي تعمل طوال الأسبوع."
        },
        {
          id: "pr-hold",
          label: { fa: "نگه‌داشتن تا آخر هفته", en: "Hold over the weekend", ar: "الاحتفاظ عبر العطلة" },
          fa: "اجازهٔ عبور پوزیشن از تعطیلات. اگر قرارداد شما این را ممنوع کرده، خاموش بگذارید؛ ساعت بستن جمعه همین را اجرا می‌کند.",
          en: "Allows a position to cross the weekend. If your contract forbids it, keep this off; the Friday close hour is what enforces it.",
          ar: "يسمح بعبور المركز للعطلة؛ أبقه مغلقاً إن منعه العقد."
        },
        {
          id: "pr-hedge",
          label: { fa: "هجینگ", en: "Hedging", ar: "التحوط" },
          fa: "اجازهٔ داشتن خرید و فروش هم‌زمان روی یک نماد. بعضی شرکت‌ها آن را ممنوع کرده‌اند و بعضی حساب‌ها اصلاً netting هستند و از نظر فنی نمی‌توانند. خاموش کردنش هیچ‌وقت باعث رد شدن از قانون نمی‌شود.",
          en: "Allows a buy and a sell on the same instrument at once. Some firms forbid it, and some accounts are netting and cannot do it at all. Turning it off never breaks a rule.",
          ar: "يسمح بشراء وبيع على الرمز نفسه؛ بعض الشركات تمنعه."
        },
        {
          id: "pr-save",
          label: { fa: "ذخیرهٔ قوانین", en: "Save rules", ar: "حفظ القواعد" },
          fa: "تا وقتی ذخیره نزده‌اید هیچ تغییری اعمال نشده. بعد از ذخیره، وضعیت بالای صفحه بلافاصله با عددهای جدید محاسبه می‌شود.",
          en: "Nothing is applied until you press save. Afterwards the status card above recalculates at once against the new numbers.",
          ar: "لا يُطبَّق شيء قبل الحفظ، وبعده تُحدَّث البطاقة فوراً."
        }
      ]
    },
    {
      id: "howto",
      title: { fa: "دستور کار: از صفر تا یک حساب چلنج", en: "Working order: from nothing to a challenge account", ar: "خطوات الإعداد لحساب تحدٍّ" },
      lede: {
        fa: "به همین ترتیب جلو بروید؛ هر مرحله به مرحلهٔ قبل تکیه دارد.",
        en: "Work in this order; each step depends on the one before it.",
        ar: "اتبع هذا الترتيب؛ كل خطوة تعتمد على سابقتها."
      },
      rows: [
        {
          id: "step-1",
          label: { fa: "۱) ساعت سیستم را درست کنید", en: "1) Fix the clock first", ar: "١) اضبط الساعة أولاً" },
          fa: "تنظیمات ← سیستم ← منطقهٔ زمانی. تا این درست نباشد، ساعت‌های این صفحه ساعتی را می‌بندند که منظورتان نبوده — و متداول‌ترین شکایت «پراپ اصلاً معامله نمی‌کند» دقیقاً همین است.",
          en: "Settings → System → timezone. Until that is right, the hours on this page close a window you did not mean — and \"prop never trades\" is almost always this.",
          ar: "الإعدادات ← النظام ← المنطقة الزمنية قبل كل شيء."
        },
        {
          id: "step-2",
          label: { fa: "۲) پروفایل شرکت را بگیرید", en: "2) Take the firm's profile", ar: "٢) اختر ملف الشركة" },
          fa: "اگر هست انتخابش کنید، اگر نیست custom. بعد عددها را با قرارداد سطر به سطر مقایسه کنید.",
          en: "Select it if it exists, otherwise custom. Then compare the numbers line by line with the contract.",
          ar: "اختر الملف إن وُجد وإلا custom، ثم قارن مع العقد."
        },
        {
          id: "step-3",
          label: { fa: "۳) حاشیهٔ امن بگذارید", en: "3) Leave a margin of safety", ar: "٣) اترك هامش أمان" },
          fa: "حد ضرر روزانه و افت کل را حدود ۲۰٪ سخت‌گیرانه‌تر از قرارداد بگذارید. کمیسیون، سوآپ و اسپرد لحظهٔ خبر همان ۲۰٪ را می‌خورند.",
          en: "Set the daily loss and drawdown about twenty per cent tighter than the contract. Commission, swap and a news-minute spread eat exactly that twenty per cent.",
          ar: "اجعل الحدود أصرم بنحو ٢٠٪ من العقد لتغطية العمولة والسبريد."
        },
        {
          id: "step-4",
          label: { fa: "۴) ریسک هر معامله را از افت کل حساب کنید", en: "4) Derive risk per trade from the drawdown", ar: "٤) اشتق المخاطرة من حد التراجع" },
          fa: "قاعدهٔ سرانگشتی: ریسک هر معامله = افت مجاز ÷ ۱۰. با این نسبت، ده ضرر پیاپی هنوز شما را در بازی نگه می‌دارد.",
          en: "Rule of thumb: risk per trade = allowed drawdown ÷ 10. At that ratio ten losses in a row still leave you in the game.",
          ar: "قاعدة عملية: المخاطرة = حد التراجع ÷ ١٠."
        },
        {
          id: "step-5",
          label: { fa: "۵) اول مشاهده، بعد شلیک", en: "5) Observe before firing", ar: "٥) راقب قبل التنفيذ" },
          fa: "یک روز با پراپ روشن ولی اجرای خودکار خاموش کار کنید و در صفحهٔ استراتژی‌ها بخوانید که هر بار دقیقاً چه چیزی جلوی ورود را گرفته. اگر همیشه یک قانون است، همان را تنظیم کنید.",
          en: "Run a day with prop on and auto-execution off, then read on the strategies page exactly what stopped each entry. If it is always the same rule, that is the one to adjust.",
          ar: "شغّل يوماً بالمراقبة فقط واقرأ سبب المنع في صفحة الاستراتيجيات."
        }
      ]
    },
    {
      id: "quiet",
      title: { fa: "اگر هیچ معامله‌ای انجام نمی‌شود", en: "If nothing is trading", ar: "إذا لم يحدث أي تداول" },
      lede: {
        fa: "میز هیچ‌وقت بی‌دلیل ساکت نیست. ترتیب زیر را از بالا به پایین بررسی کنید.",
        en: "The desk is never quiet without a reason. Check these in order, top to bottom.",
        ar: "المكتب لا يصمت بلا سبب؛ تحقق بالترتيب."
      },
      rows: [
        {
          id: "quiet-1",
          label: { fa: "۱) دلیل روی کارت استراتژی", en: "1) The reason on the strategy card", ar: "١) السبب على بطاقة الاستراتيجية" },
          fa: "هر استراتژی زیر کارتش می‌نویسد آخرین بار چرا وارد نشد (مثلاً «قیمت در ناحیهٔ ورود نیست» یا «نسبت سود به ضرر کم است»). نگه‌داشتن نشانگر روی همان خط، شمارش همهٔ دلیل‌های این نشست را نشان می‌دهد؛ اگر یک دلیل بیشتر موارد را گرفته، همان پارامتر را عوض کنید.",
          en: "Each strategy writes under its card why it last declined (\"price is not in an entry zone\", \"reward-to-risk too low\"). Hovering that line shows the tally of every reason this session; when one reason dominates, that is the parameter to change.",
          ar: "تكتب كل استراتيجية سبب امتناعها الأخير، ويظهر التجميع عند المرور على السطر."
        },
        {
          id: "quiet-2",
          label: { fa: "۲) وضعیت قفل همین صفحه", en: "2) The lock state on this page", ar: "٢) حالة القفل في هذه الصفحة" },
          fa: "اگر کارت بالا قفل را نشان می‌دهد، خط زیرش می‌گوید کدام قانون شکسته — حد روزانه، افت کل، ضررهای پیاپی یا ساعت.",
          en: "If the card above shows locked, the line under it names the rule that broke — daily loss, drawdown, consecutive losses or the hours.",
          ar: "إذا ظهر القفل فالسطر أسفله يسمّي القاعدة المخالفة."
        },
        {
          id: "quiet-3",
          label: { fa: "۳) ساعت و روز", en: "3) Hours and day", ar: "٣) الساعة واليوم" },
          fa: "خط «به وقت بروکر» زیر فیلدهای ساعت را بخوانید. اختلاف زمانی، و جمعه‌ها ساعت بستن، رایج‌ترین دلیل سکوتِ بی‌سروصدا هستند.",
          en: "Read the \"at the broker\" line under the hour fields. A timezone difference, and the Friday close on Fridays, are the commonest cause of a silent desk.",
          ar: "اقرأ سطر توقيت الوسيط أسفل حقول الساعة."
        },
        {
          id: "quiet-4",
          label: { fa: "۴) فیلتر نماد", en: "4) The symbol filter", ar: "٤) مرشّح الرموز" },
          fa: "اگر نمادی انتخاب کرده‌اید که با پسوند بروکر فرق دارد یا اصلاً در حساب شما نیست، همهٔ سیگنال‌ها رد می‌شوند. فهرست را باز کنید و ببینید نماد چارت فعال تیک دارد یا نه.",
          en: "A symbol chosen with a different broker suffix, or one not on your account at all, refuses every signal. Open the list and check the symbol of the live chart is ticked.",
          ar: "رمز بلاحقة مختلفة أو غير متاح في حسابك يرفض كل الإشارات."
        }
      ]
    }
  ];

  function pick(text, lang) {
    if (!text) return "";
    return text[lang] || text.en || text.fa || "";
  }

  root.PROP_GUIDE = { SECTIONS, pick };
})(typeof window !== "undefined" ? window : globalThis);
