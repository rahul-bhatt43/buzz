package com.buzz.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.app.UiModeManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.text.TextUtils
import android.util.Base64
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask

/**
 * The whole browser screen.
 *
 * - Each tab is a system (Chromium) WebView with no access to app APIs.
 * - Buzz's own screens (new tab, tabs, search, history, downloads, settings)
 *   run in one separate "panel" WebView that only ever loads bundled files and
 *   is the only place the native bridge is exposed.
 */
class MainActivity : Activity() {
    private lateinit var settings: Settings
    private lateinit var store: Store

    private val tabs = ArrayList<Tab>()
    private var active: Tab? = null
    private var nextTabId = 1

    private lateinit var root: FrameLayout
    private lateinit var tabContainer: FrameLayout
    private lateinit var panel: WebView
    private lateinit var toolbar: LinearLayout
    private lateinit var progressBar: View
    private lateinit var addressView: TextView
    private lateinit var shieldButton: TextView
    private lateinit var tabsButton: TextView
    private lateinit var menuButton: ImageButton

    /** The Buzz screen being shown over the page, or null when the page itself is visible. */
    private var panelRoute: String? = null
    private var panelReady = false
    private var pendingPanel: Pair<String, JSONObject>? = null

    private var palettes: Pair<Palette, Palette>? = null // normal, private
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var refreshQueued = false

    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    // Read on WebView's request thread for every network request, so cached here.
    @Volatile private var adblockOn = true
    @Volatile private var shieldsOffHosts: Set<String> = emptySet()

    private val privateSupported by lazy { WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) }

    private class Palette(val chrome: Int, val surface: Int, val ink: Int, val muted: Int, val line: Int, val accent: Int)

    // ------------------------------------------------------------ lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = Settings(this)
        store = Store(this)
        refreshSettingsCache()
        if (Shields.totalBlocked.get() == 0) Shields.totalBlocked.set(settings.totalBlocked)
        Shields.load(applicationContext) { runOnUiThread { pushState() } }
        worker.execute { store.prune() }

        buildUi()
        deletePrivateProfile()
        restoreSession()
        val opened = urlFrom(intent)
        if (opened != null) createTab(opened) else if (tabs.isEmpty()) createTab("")
        if (active == null) activate(tabs.last())
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        urlFrom(intent)?.let { createTab(it) }
    }

    private fun urlFrom(intent: Intent?): String? =
        intent?.takeIf { it.action == Intent.ACTION_VIEW }?.dataString?.takeIf { Urls.isWebUrl(it) }

    override fun onPause() {
        super.onPause()
        active?.webView?.onPause()
    }

    override fun onResume() {
        super.onResume()
        active?.webView?.onResume()
    }

    override fun onStop() {
        super.onStop()
        saveSession()
    }

    override fun onDestroy() {
        for (tab in tabs) destroyWebView(tab)
        panel.destroy()
        worker.shutdown()
        super.onDestroy()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        // Buzz is in the background and the system is short on memory: keep only the current tab.
        if (level >= TRIM_MEMORY_BACKGROUND) tabs.filter { it !== active }.forEach { sleep(it) }
    }

    /**
     * Non-private tabs survive restarts as sleeping tabs. Saved whenever the set
     * of open pages changes, because Android can kill the app without warning.
     */
    private fun saveSession() {
        settings.totalBlocked = Shields.totalBlocked.get()
        val saved = JSONArray()
        var activeIndex = 0
        for (tab in tabs) {
            if (tab.isPrivate || !Urls.isWebUrl(tab.displayUrl)) continue
            if (tab === active) activeIndex = saved.length()
            saved.put(JSONObject().put("url", tab.displayUrl).put("title", tab.title))
        }
        settings.saveSession(saved, activeIndex)
    }

    private fun restoreSession() {
        val (saved, activeIndex) = settings.session()
        for (i in 0 until saved.length()) {
            val entry = saved.optJSONObject(i) ?: continue
            val url = entry.optString("url")
            if (!Urls.isWebUrl(url)) continue
            tabs.add(Tab(nextTabId++, false).apply { this.url = url; title = entry.optString("title") })
        }
        tabs.getOrNull(activeIndex)?.let { activate(it) }
    }

    // ------------------------------------------------------------------- UI

    private fun dp(value: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    private val isNight: Boolean
        get() = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

    private fun pressable(view: View) {
        val value = TypedValue()
        theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, value, true)
        view.setBackgroundResource(value.resourceId)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildUi() {
        val match = ViewGroup.LayoutParams.MATCH_PARENT
        root = FrameLayout(this)
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val content = FrameLayout(this)
        tabContainer = FrameLayout(this)
        panel = WebView(this)
        content.addView(tabContainer, match, match)
        content.addView(panel, match, match)
        column.addView(content, LinearLayout.LayoutParams(match, 0, 1f))

        // Bottom toolbar: page-load progress line, then shields / address / tabs / menu.
        toolbar = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        progressBar = View(this).apply { pivotX = 0f; scaleX = 0f; visibility = View.INVISIBLE }
        toolbar.addView(progressBar, LinearLayout.LayoutParams(match, dp(3)))
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), 0, dp(6), 0)
        }
        shieldButton = TextView(this).apply {
            gravity = Gravity.CENTER
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            compoundDrawablePadding = dp(5)
            setPadding(dp(10), 0, dp(10), 0)
            contentDescription = "Shields"
            setOnClickListener { showPanel("shields") }
        }
        pressable(shieldButton)
        addressView = TextView(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            textSize = 15.5f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setPadding(dp(15), 0, dp(15), 0)
            setOnClickListener { showPanel("search", JSONObject().put("text", active?.displayUrl ?: "")) }
        }
        tabsButton = TextView(this).apply {
            gravity = Gravity.CENTER
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            contentDescription = "Tabs"
            setOnClickListener { showPanel("tabs") }
        }
        menuButton = ImageButton(this).apply {
            setImageResource(R.drawable.ic_more)
            contentDescription = "Menu"
            setOnClickListener { showMenu() }
        }
        pressable(menuButton)
        row.addView(shieldButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(42)))
        row.addView(addressView, LinearLayout.LayoutParams(0, dp(42), 1f))
        row.addView(tabsButton, LinearLayout.LayoutParams(dp(28), dp(28)).apply { leftMargin = dp(14); rightMargin = dp(6) })
        row.addView(menuButton, LinearLayout.LayoutParams(dp(42), dp(42)))
        toolbar.addView(row, LinearLayout.LayoutParams(match, dp(56)))
        column.addView(toolbar, LinearLayout.LayoutParams(match, ViewGroup.LayoutParams.WRAP_CONTENT))

        root.addView(column, match, match)
        setContentView(root)
        applyWindowInsets()

        palettes = settings.palette?.let { parsePalettes(it) }
        applyPalette()

        panel.settings.javaScriptEnabled = true
        panel.settings.domStorageEnabled = true
        // The panel holds the native bridge, so it may never touch the network.
        panel.settings.blockNetworkLoads = true
        panel.addJavascriptInterface(Bridge(), "BuzzNative")
        panel.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith(PANEL_BASE)) return false
                if (Urls.isWebUrl(url)) openInActiveTab(url)
                return true
            }
        }
        panel.loadUrl(PANEL_BASE + "index.html")
    }

    /** Draw behind the system bars and keep content clear of them and of the keyboard. */
    private fun applyWindowInsets() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        window.setDecorFitsSystemWindows(false)
        root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
            if (fullscreenView == null) view.setPadding(bars.left, bars.top, bars.right, bars.bottom) else view.setPadding(0, 0, 0, 0)
            WindowInsets.CONSUMED
        }
    }

    private fun parsePalettes(json: String): Pair<Palette, Palette>? = try {
        val data = JSONObject(json)
        if (data.optBoolean("night") != isNight) null else {
            fun read(o: JSONObject) = Palette(
                Color.parseColor(o.getString("chrome")), Color.parseColor(o.getString("surface")), Color.parseColor(o.getString("ink")),
                Color.parseColor(o.getString("muted")), Color.parseColor(o.getString("line")), Color.parseColor(o.getString("accent")),
            )
            read(data.getJSONObject("normal")) to read(data.getJSONObject("private"))
        }
    } catch (e: Exception) {
        null
    }

    private fun defaultPalette(): Palette =
        if (isNight) Palette(0xFF1A1711.toInt(), 0xFF2A251C.toInt(), 0xFFF3ECDC.toInt(), 0xFFA59C88.toInt(), 0xFF36302A.toInt(), 0xFFFFBE2E.toInt())
        else Palette(0xFFF3ECDC.toInt(), 0xFFFFFAF0.toInt(), 0xFF1D1A14.toInt(), 0xFF6F6858.toInt(), 0xFFD9CFB8.toInt(), 0xFFF2A900.toInt())

    /** Colour the native toolbar and system bars to match the theme the UI is showing. */
    private fun applyPalette() {
        val p = palettes?.let { if (active?.isPrivate == true) it.second else it.first } ?: defaultPalette()
        root.setBackgroundColor(p.chrome)
        toolbar.setBackgroundColor(p.chrome)
        panel.setBackgroundColor(p.chrome)
        progressBar.setBackgroundColor(p.accent)
        addressView.background = GradientDrawable().apply {
            cornerRadius = dp(13).toFloat()
            setColor(p.surface)
            setStroke(dp(1), p.line)
        }
        addressView.setTextColor(p.ink)
        tabsButton.background = GradientDrawable().apply {
            cornerRadius = dp(8).toFloat()
            setStroke(dp(2), p.ink)
        }
        tabsButton.setTextColor(p.ink)
        shieldButton.setTextColor(p.ink)
        val shield = getDrawable(R.drawable.ic_shield)!!.mutate().apply {
            setBounds(0, 0, dp(20), dp(20))
            setTint(p.ink)
        }
        shieldButton.setCompoundDrawables(shield, null, null, null)
        menuButton.imageTintList = ColorStateList.valueOf(p.ink)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (Color.luminance(p.chrome) > 0.5f) light else 0, light)
        }
    }

    private fun updateToolbar() {
        val tab = active ?: return
        val url = tab.displayUrl
        addressView.text = when {
            tab.isBlank -> "Search or enter address"
            url.startsWith("http://") -> "Not secure · " + Urls.hostOf(url)
            Urls.isWebUrl(url) -> Urls.hostOf(url)
            else -> url
        }
        addressView.alpha = if (tab.isBlank) 0.62f else 1f
        tabsButton.text = if (tabs.size > 99) ":D" else tabs.size.toString()
        shieldButton.text = tab.blocked.get().toString()
        shieldButton.alpha = if (adblockOn && Urls.hostOf(url) !in shieldsOffHosts) 1f else 0.45f
        progressBar.visibility = if (tab.loading) View.VISIBLE else View.INVISIBLE
        progressBar.scaleX = tab.progress / 100f
    }

    /** Coalesce bursts of updates (every blocked request triggers one) into a few redraws. */
    private fun queueRefresh() {
        if (refreshQueued) return
        refreshQueued = true
        handler.postDelayed({
            refreshQueued = false
            updateToolbar()
            pushState()
        }, 250)
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    private fun showMenu() {
        val tab = active ?: return
        val webView = tab.webView
        val onPage = Urls.isWebUrl(tab.displayUrl)
        PopupMenu(this, menuButton).apply {
            menu.add(0, 1, 0, "New tab")
            menu.add(0, 2, 0, "New private tab")
            menu.add(0, 3, 0, "Forward").isEnabled = webView?.canGoForward() == true
            menu.add(0, 4, 0, "Reload").isEnabled = webView != null
            menu.add(0, 5, 0, if (tab.readerOf != null) "Exit reader mode" else "Reader mode").isEnabled = onPage
            menu.add(0, 6, 0, "Share").isEnabled = onPage
            menu.add(0, 7, 0, "History")
            menu.add(0, 8, 0, "Downloads")
            menu.add(0, 9, 0, "Settings")
            setOnMenuItemClickListener { item ->
                when (item.itemId) {
                    1 -> createTab("")
                    2 -> createTab("", isPrivate = true)
                    3 -> webView?.goForward()
                    4 -> if (tab.readerOf != null) exitReader(tab) else webView?.reload()
                    5 -> toggleReader(tab)
                    6 -> startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, tab.displayUrl), null))
                    7 -> showPanel("history")
                    8 -> showPanel("downloads")
                    9 -> showPanel("settings")
                }
                true
            }
            show()
        }
    }

    // ---------------------------------------------------------------- panel

    private fun showPanel(route: String, params: JSONObject = JSONObject()) {
        panelRoute = route
        panel.visibility = View.VISIBLE
        toolbar.visibility = if (route == "newtab") View.VISIBLE else View.GONE
        if (route != "search") hideKeyboard()
        if (panelReady) panel.evaluateJavascript("Buzz.show(${JSONObject.quote(route)}, $params)", null)
        else pendingPanel = route to params
    }

    /** Back to the page, or to the new tab screen when the tab has no page yet. */
    private fun hidePanel() {
        val tab = active
        if (tab == null || tab.isBlank) {
            showPanel("newtab")
            return
        }
        panelRoute = null
        panel.visibility = View.GONE
        if (panelReady) panel.evaluateJavascript("Buzz.hidden()", null)
        toolbar.visibility = View.VISIBLE
        hideKeyboard()
        tab.webView?.requestFocus()
    }

    private fun hideKeyboard() {
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(root.windowToken, 0)
    }

    /** Tell the panel that tabs or counters changed, if it is showing something that depends on them. */
    private fun pushState() {
        if (panelReady && panelRoute != null) panel.evaluateJavascript("Buzz.onEvent('state')", null)
    }

    // ----------------------------------------------------------------- tabs

    private fun createTab(url: String, isPrivate: Boolean = false, opener: Tab? = null, activate: Boolean = true): Tab? {
        if (isPrivate && !privateSupported) {
            toast("Private tabs need a newer Android System WebView")
            return null
        }
        val tab = Tab(nextTabId++, isPrivate)
        val index = opener?.let { tabs.indexOf(it) } ?: -1
        if (index >= 0) tabs.add(index + 1, tab) else tabs.add(tab)
        if (url.isNotEmpty()) tab.url = url
        if (activate) activate(tab)
        return tab
    }

    private fun activate(tab: Tab) {
        val previous = active
        if (previous !== tab) {
            previous?.lastActive = System.currentTimeMillis()
            previous?.webView?.let {
                it.onPause()
                tabContainer.removeView(it)
            }
            active = tab
        }
        if (tab.isBlank) {
            showPanel("newtab")
        } else {
            val webView = wake(tab)
            if (webView.parent == null) tabContainer.addView(webView, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            webView.onResume()
            val pending = tab.insecurePending
            if (pending != null) showPanel("insecure", JSONObject().put("url", pending).put("host", Urls.hostOf(pending)))
            else hidePanel()
        }
        enforceLiveLimit()
        applyPalette()
        updateToolbar()
        pushState()
        saveSession()
    }

    private fun closeTab(tab: Tab) {
        val index = tabs.indexOf(tab)
        if (index < 0) return
        destroyWebView(tab)
        Shields.forgetTab(tab.id)
        tabs.removeAt(index)
        if (tab.isPrivate && tabs.none { it.isPrivate }) handler.postDelayed({ deletePrivateProfile() }, 1500)
        if (tabs.isEmpty()) {
            active = null
            createTab("")
            return
        }
        if (active === tab) {
            active = null
            activate(tabs[minOf(index, tabs.size - 1)])
        } else {
            updateToolbar()
            pushState()
            saveSession()
        }
    }

    /** Load a typed address or search in a tab. */
    private fun navigate(tab: Tab, input: String) {
        val engine = settings.choice("searchEngine")
        var url = Urls.fromAddressInput(input) { Search.searchUrl(engine, it) } ?: return
        if (!Urls.isWebUrl(url)) return
        if (settings.toggle("httpsUpgrade")) url = Shields.upgrade(tab.id, url) ?: url
        if (tab.readerOf != null) leaveReaderState(tab)
        tab.insecurePending = null
        tab.url = url
        tab.savedState = null
        val existing = tab.webView
        if (existing != null) existing.loadUrl(url)
        if (tab === active) activate(tab)
    }

    private fun openInActiveTab(url: String) {
        val tab = active ?: createTab("") ?: return
        navigate(tab, url)
    }

    // -------------------------------------------------- web views and memory

    /** Make sure the tab has a live WebView, restoring its page if it was asleep. */
    @SuppressLint("SetJavaScriptEnabled")
    private fun wake(tab: Tab): WebView {
        tab.webView?.let { return it }
        val webView = WebView(this)
        val cookies = if (tab.isPrivate) {
            // A separate browser profile: its cookies, cache and storage never mix with normal tabs.
            ProfileStore.getInstance().getOrCreateProfile(PRIVATE_PROFILE)
            WebViewCompat.setProfile(webView, PRIVATE_PROFILE)
            WebViewCompat.getProfile(webView).cookieManager
        } else {
            CookieManager.getInstance()
        }
        cookies.setAcceptThirdPartyCookies(webView, false)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            builtInZoomControls = true
            displayZoomControls = false
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportMultipleWindows(true)
            // Present as Chrome for Android rather than as an embedded WebView.
            userAgentString = userAgentString.replace("; wv", "").replace(Regex("Version/\\S+\\s"), "")
        }
        webView.webViewClient = PageClient(tab)
        webView.webChromeClient = ChromeClient(tab)
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            download(tab, url, userAgent, contentDisposition, mimeType)
        }
        tab.webView = webView
        val saved = tab.savedState
        tab.savedState = null
        if (saved == null || webView.restoreState(saved) == null) {
            // A plain-HTTP address (for example a restored tab) gets the same upgrade as a typed one.
            val upgraded = if (settings.toggle("httpsUpgrade")) Shields.upgrade(tab.id, tab.url) else null
            if (tab.url != NEW_WINDOW_URL) webView.loadUrl(upgraded ?: tab.url)
            tab.insecurePending = null
        }
        return webView
    }

    private fun destroyWebView(tab: Tab) {
        val webView = tab.webView ?: return
        tab.webView = null
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.stopLoading()
        webView.destroy()
    }

    /** Free a background tab's page; it is rebuilt from its saved history when opened again. */
    private fun sleep(tab: Tab) {
        val webView = tab.webView ?: return
        if (tab === active) return
        if (tab.readerOf != null) {
            // A reader view cannot be restored; come back to the article itself.
            tab.url = tab.readerOf ?: tab.url
            tab.readerOf = null
        } else {
            val state = Bundle()
            tab.savedState = if (webView.saveState(state) != null) state else null
        }
        tab.loading = false
        destroyWebView(tab)
    }

    /** Memory saver: only the most recently used tabs keep a live page. */
    private fun enforceLiveLimit() {
        val limit = if (settings.toggle("memorySaver")) LIVE_TABS_SAVER else LIVE_TABS_MAX
        tabs.filter { it.webView != null && it !== active }
            .sortedByDescending { it.lastActive }
            .drop(limit - 1)
            .forEach { sleep(it) }
    }

    private fun deletePrivateProfile() {
        if (!privateSupported || tabs.any { it.isPrivate }) return
        try {
            ProfileStore.getInstance().deleteProfile(PRIVATE_PROFILE)
        } catch (e: Exception) {
            // Still in use by a page being torn down; it is deleted on the next launch.
            Log.i(TAG, "Private profile not deleted yet: ${e.message}")
        }
    }

    private inner class PageClient(private val tab: Tab) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (!Urls.isWebUrl(url)) {
                // tel:, mailto:, intent: and friends go to other apps, only when the user tapped.
                if (request.hasGesture() && request.url.scheme !in INTERNAL_SCHEMES) openExternally(url)
                return request.url.scheme !in INTERNAL_SCHEMES
            }
            if (!request.isForMainFrame) return false
            if (tab.readerOf != null) leaveReaderState(tab)
            if (settings.toggle("httpsUpgrade")) {
                if (request.isRedirect && Shields.isDowngrade(tab.id, url)) {
                    // The site answered our HTTPS upgrade by sending us back to HTTP.
                    // Upgrading again would loop forever, so ask instead.
                    offerInsecureFallback(tab, "https://" + url.substring("http://".length))
                    return true
                }
                Shields.upgrade(tab.id, url)?.let {
                    view.loadUrl(it)
                    return true
                }
            }
            return false
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val host = request.url.host?.lowercase() ?: return null
            if (host == READER_HOST) return readerAsset(request.url.path ?: "")
            if (request.isForMainFrame || !adblockOn || tab.readerOf != null) return null
            val page = tab.url
            if (Urls.hostOf(page) in shieldsOffHosts) return null
            if (!Shields.list.shouldBlock(host, Urls.rawHost(page))) return null
            tab.blocked.incrementAndGet()
            Shields.totalBlocked.incrementAndGet()
            handler.post { queueRefresh() }
            return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            // Moving on to a different site answers the pending "not secure" question.
            if (tab.insecurePending?.let { Urls.rawHost(it) != Urls.rawHost(url) } == true) tab.insecurePending = null
            if (tab.readerOf == null && Urls.isWebUrl(url)) tab.url = url
            tab.blocked.set(0)
            tab.loading = true
            tab.icon = null
            if (tab === active) updateToolbar()
        }

        override fun onPageFinished(view: WebView, url: String) {
            tab.loading = false
            if (tab === active) updateToolbar()
            pushState()
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            if (tab.readerOf != null || !Urls.isWebUrl(url) || url.startsWith(Reader.ORIGIN)) return
            tab.url = url
            if (tab === active) updateToolbar()
            saveSession()
            // History: one entry per page (not per reload or #fragment), never for private tabs.
            if (tab.isPrivate || isReload || url.substringBefore('#') == tab.visitUrl.substringBefore('#')) return
            tab.visitUrl = url
            worker.execute { tab.visitId = store.addVisit(url, "") }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame || error.errorCode == ERROR_HOST_LOOKUP) return
            offerInsecureFallback(tab, request.url.toString())
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            if (error.url == view.url || error.url == tab.url) offerInsecureFallback(tab, error.url)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The page's process died (often the system reclaiming memory). Drop
            // the dead view instead of letting it take the whole app down.
            tab.savedState = null
            tab.loading = false
            destroyWebView(tab)
            if (tab === active) activate(tab)
            return true
        }
    }

    private inner class ChromeClient(private val tab: Tab) : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            tab.progress = newProgress
            if (tab === active) updateToolbar()
        }

        override fun onReceivedTitle(view: WebView, title: String?) {
            if (tab.readerOf != null) return
            tab.title = title ?: ""
            val url = view.url
            if (!tab.isPrivate) worker.execute { if (tab.visitId > 0 && tab.visitUrl == url) store.setTitle(tab.visitId, tab.title) }
            pushState()
            saveSession()
        }

        override fun onReceivedIcon(view: WebView, icon: Bitmap?) {
            if (icon == null || tab.readerOf != null) return
            val out = ByteArrayOutputStream()
            Bitmap.createScaledBitmap(icon, 48, 48, true).compress(Bitmap.CompressFormat.PNG, 100, out)
            tab.icon = "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            pushState()
        }

        /** Links that ask for a new window open as a new tab. */
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            if (!isUserGesture) return false
            val child = createTab(NEW_WINDOW_URL, tab.isPrivate, opener = tab) ?: return false
            (resultMsg.obj as WebView.WebViewTransport).webView = child.webView
            resultMsg.sendToTarget()
            return true
        }

        override fun onCloseWindow(window: WebView) = closeTab(tab)

        // Camera, microphone and location are declined: Buzz does not request those permissions.
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
            callback.invoke(origin, false, false)

        override fun onShowFileChooser(webView: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                @Suppress("DEPRECATION")
                startActivityForResult(params.createIntent(), REQUEST_FILE)
                true
            } catch (e: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (fullscreenView != null) {
                callback.onCustomViewHidden()
                return
            }
            fullscreenView = view
            fullscreenCallback = callback
            root.addView(view, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            view.setBackgroundColor(Color.BLACK)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) window.insetsController?.hide(WindowInsets.Type.systemBars())
            root.requestApplyInsets()
        }

        override fun onHideCustomView() = exitFullscreen()
    }

    private fun exitFullscreen() {
        val view = fullscreenView ?: return
        root.removeView(view)
        fullscreenView = null
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) window.insetsController?.show(WindowInsets.Type.systemBars())
        root.requestApplyInsets()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_FILE) return
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
        fileCallback = null
    }

    private fun openExternally(url: String) {
        try {
            val intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME).apply {
                // A web page may only reach activities that declare themselves browsable.
                addCategory(Intent.CATEGORY_BROWSABLE)
                component = null
                selector = null
            }
            startActivity(intent)
        } catch (e: Exception) {
            toast("No app can open this link")
        }
    }

    /** An HTTPS upgrade failed: ask before falling back to the plain-HTTP site. */
    private fun offerInsecureFallback(tab: Tab, failedUrl: String) {
        val httpUrl = Shields.fallbackFor(tab.id, failedUrl) ?: return
        // Remember the address the user asked for, not the upgrade that failed.
        tab.insecurePending = httpUrl
        saveSession()
        if (tab === active) showPanel("insecure", JSONObject().put("url", httpUrl).put("host", Urls.hostOf(httpUrl)))
    }

    // --------------------------------------------------------------- reader

    private fun readerAsset(path: String): WebResourceResponse? {
        val name = path.removePrefix("/fonts/")
        if (!path.startsWith("/fonts/") || !FONT_NAME.matches(name)) return null
        return try {
            WebResourceResponse("font/woff2", null, assets.open("ui/shared/fonts/$name"))
        } catch (e: Exception) {
            null
        }
    }

    private fun toggleReader(tab: Tab) {
        val webView = tab.webView ?: return
        if (tab.readerOf != null) {
            exitReader(tab)
            return
        }
        val url = tab.url
        webView.evaluateJavascript(Reader.script(this)) { raw ->
            val article = Reader.parseResult(raw)
            if (tab.webView !== webView || tab.url != url) return@evaluateJavascript
            if (article == null) {
                toast("Reader mode is not available for this page")
                return@evaluateJavascript
            }
            // The article is untrusted HTML: show it with scripting switched off.
            tab.readerOf = url
            webView.settings.javaScriptEnabled = false
            webView.loadDataWithBaseURL(Reader.ORIGIN + "/", Reader.page(this, article, url, settings, tab.isPrivate), "text/html", "UTF-8", url)
            updateToolbar()
        }
    }

    /** Restore normal page behaviour after the reader view (does not navigate). */
    @SuppressLint("SetJavaScriptEnabled")
    private fun leaveReaderState(tab: Tab) {
        tab.readerOf = null
        tab.webView?.settings?.javaScriptEnabled = true
    }

    private fun exitReader(tab: Tab) {
        val original = tab.readerOf ?: return
        val webView = tab.webView ?: return
        leaveReaderState(tab)
        if (webView.canGoBack()) webView.goBack() else webView.loadUrl(original)
        updateToolbar()
    }

    // ------------------------------------------------------------ downloads

    private val downloadManager: DownloadManager get() = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

    private fun download(tab: Tab, url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
        if (!Urls.isWebUrl(url)) {
            toast("This kind of download is not supported yet")
            return
        }
        val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
        val cookieManager = tab.webView?.takeIf { tab.isPrivate }?.let { WebViewCompat.getProfile(it).cookieManager } ?: CookieManager.getInstance()
        val request = DownloadManager.Request(Uri.parse(url)).apply {
            setTitle(name)
            setMimeType(mimeType)
            userAgent?.let { addRequestHeader("User-Agent", it) }
            cookieManager.getCookie(url)?.let { addRequestHeader("Cookie", it) }
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
        }
        try {
            downloadManager.enqueue(request)
            toast("Downloading $name")
        } catch (e: Exception) {
            toast("Download could not start")
        }
        // A tab opened only to start this download is left empty: close it.
        if (tab.url == NEW_WINDOW_URL && tabs.size > 1) closeTab(tab)
    }

    private fun listDownloads(): JSONArray {
        val out = JSONArray()
        downloadManager.query(DownloadManager.Query()).use { c ->
            val id = c.getColumnIndexOrThrow(DownloadManager.COLUMN_ID)
            val title = c.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE)
            val status = c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)
            val total = c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)
            val received = c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)
            val uri = c.getColumnIndexOrThrow(DownloadManager.COLUMN_URI)
            val time = c.getColumnIndexOrThrow(DownloadManager.COLUMN_LAST_MODIFIED_TIMESTAMP)
            while (c.moveToNext()) {
                val state = when (c.getInt(status)) {
                    DownloadManager.STATUS_SUCCESSFUL -> "completed"
                    DownloadManager.STATUS_FAILED -> "failed"
                    DownloadManager.STATUS_PAUSED -> "paused"
                    else -> "progressing"
                }
                out.put(
                    JSONObject().put("id", c.getLong(id)).put("filename", c.getString(title) ?: "Download").put("state", state)
                        .put("total", maxOf(0L, c.getLong(total))).put("received", c.getLong(received))
                        .put("host", Urls.hostOf(c.getString(uri) ?: "")).put("time", c.getLong(time)),
                )
            }
        }
        return out
    }

    private fun openDownload(id: Long) {
        val uri = downloadManager.getUriForDownloadedFile(id)
        if (uri == null) {
            toast("The file is not available")
            return
        }
        try {
            startActivity(
                Intent(Intent.ACTION_VIEW).setDataAndType(uri, downloadManager.getMimeTypeForDownloadedFile(id))
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
            )
        } catch (e: ActivityNotFoundException) {
            toast("No app can open this file")
        }
    }

    // ------------------------------------------------------- bridge to panel

    /** Run [block] on the main thread and wait for its result. */
    private fun <T> onMain(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val task = FutureTask(Callable { block() })
        runOnUiThread(task)
        return task.get()
    }

    private inner class Bridge {
        /** Called by the panel's JavaScript; the answer goes back through Buzz.resolve(id, result). */
        @JavascriptInterface
        fun post(id: Int, method: String, argsJson: String) {
            worker.execute {
                val result = try {
                    handleCall(method, JSONArray(argsJson))
                } catch (e: Exception) {
                    Log.w(TAG, "Call '$method' failed", e)
                    null
                }
                val json = when (result) {
                    is String -> JSONObject.quote(result)
                    is JSONObject, is JSONArray, is Boolean, is Number -> result.toString()
                    else -> "null"
                }
                runOnUiThread { if (!isDestroyed) panel.evaluateJavascript("Buzz.resolve($id, $json)", null) }
            }
        }
    }

    /** Runs on the worker thread; anything touching views or tabs hops to the main thread. */
    private fun handleCall(method: String, args: JSONArray): Any? = when (method) {
        "ready" -> onMain {
            panelReady = true
            pendingPanel?.let { (route, params) -> showPanel(route, params) }
            pendingPanel = null
        }
        "state" -> onMain { buildState() }
        "colors" -> onMain {
            val data = args.getJSONObject(0).put("night", isNight)
            settings.palette = data.toString()
            palettes = parsePalettes(data.toString())
            applyPalette()
        }
        "navigate" -> onMain { openInActiveTab(args.getString(0)) }
        "open-search" -> onMain { showPanel("search", JSONObject().put("text", active?.displayUrl ?: "")) }
        "open-screen" -> onMain { if (args.getString(0) in SCREENS) showPanel(args.getString(0)) }
        "focus-input" -> onMain {
            panel.requestFocus()
            (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(panel, InputMethodManager.SHOW_IMPLICIT)
        }
        "close-panel" -> onMain { hidePanel() }
        "new-tab" -> onMain { createTab("", isPrivate = args.optBoolean(0)); Unit }
        "activate-tab" -> onMain { tabs.firstOrNull { it.id == args.getInt(0) }?.let { activate(it) } }
        "close-tab" -> onMain { tabs.firstOrNull { it.id == args.getInt(0) }?.let { closeTab(it) } }
        "toggle-site" -> onMain {
            val tab = active
            val host = tab?.let { Urls.hostOf(it.displayUrl) } ?: ""
            if (tab != null && host.isNotEmpty()) {
                settings.setSiteShields(host, host in shieldsOffHosts)
                refreshSettingsCache()
                tab.webView?.reload()
                updateToolbar()
            }
        }
        "proceed-insecure" -> onMain {
            val url = args.getString(0)
            val tab = active
            if (tab != null && url.startsWith("http://")) {
                Shields.allowInsecure(url)
                tab.insecurePending = null
                tab.url = url
                tab.webView?.loadUrl(url)
                hidePanel()
            }
        }
        "insecure-back" -> onMain {
            val tab = active
            val webView = tab?.webView
            tab?.insecurePending = null
            if (webView != null && webView.canGoBack()) {
                webView.goBack()
                hidePanel()
            } else if (tab != null) {
                destroyWebView(tab)
                tab.url = ""
                tab.title = ""
                activate(tab)
            }
        }
        "set" -> {
            val key = args.getString(0)
            val ok = settings.setFromUser(key, args.opt(1))
            if (ok) onMain {
                refreshSettingsCache()
                if (key == "theme") applyThemeChoice()
                if (key == "memorySaver") enforceLiveLimit()
                updateToolbar()
            }
            ok
        }
        "suggest" -> suggest(args.optString(0))
        "top-sites" -> if (active?.isPrivate == true) JSONArray() else store.topSites(8)
        "history" -> {
            val query = args.optJSONObject(0) ?: JSONObject()
            store.query(query.optString("text").trim(), query.optLong("before"), query.optInt("limit", 100).coerceIn(1, 300))
        }
        "history-remove" -> store.remove(args.getLong(0))
        "clear-data" -> clearData(args.optJSONObject(0) ?: JSONObject())
        "downloads" -> listDownloads()
        "download-open" -> onMain { openDownload(args.getLong(0)) }
        "download-remove" -> downloadManager.remove(args.getLong(0))
        else -> null
    }

    private fun refreshSettingsCache() {
        adblockOn = settings.toggle("adblock")
        shieldsOffHosts = settings.shieldsOffHosts()
    }

    /** Light / dark / follow the system. Needs Android 12; older versions always follow the system. */
    private fun applyThemeChoice() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val mode = when (settings.choice("theme")) {
            "light" -> UiModeManager.MODE_NIGHT_NO
            "dark" -> UiModeManager.MODE_NIGHT_YES
            else -> UiModeManager.MODE_NIGHT_AUTO
        }
        (getSystemService(Context.UI_MODE_SERVICE) as UiModeManager).setApplicationNightMode(mode)
    }

    private fun buildState(): JSONObject {
        val tab = active
        val host = tab?.let { Urls.hostOf(it.displayUrl) } ?: ""
        val tabList = JSONArray()
        for (t in tabs) {
            val title = t.title.ifEmpty { if (t.isBlank) "New tab" else Urls.hostOf(t.displayUrl) }
            tabList.put(
                JSONObject().put("id", t.id).put("title", title).put("host", Urls.hostOf(t.displayUrl))
                    .put("private", t.isPrivate).put("asleep", t.isAsleep).put("active", t === tab).put("icon", t.icon ?: JSONObject.NULL),
            )
        }
        val engines = JSONArray()
        for (engine in Search.ENGINES) engines.put(JSONObject().put("id", engine.id).put("name", engine.name))
        return JSONObject()
            .put("tabs", tabList)
            .put(
                "active",
                JSONObject().put("url", tab?.displayUrl ?: "").put("host", host).put("private", tab?.isPrivate == true)
                    .put("blocked", tab?.blocked?.get() ?: 0).put("siteEnabled", host !in shieldsOffHosts),
            )
            .put("settings", settings.toJson())
            .put("engines", engines)
            .put("engineName", Search.engine(settings.choice("searchEngine")).name)
            .put("totalBlocked", Shields.totalBlocked.get())
            .put("shieldsState", Shields.state)
            .put("privateSupported", privateSupported)
            .put("canSetTheme", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            .put("version", BuildConfig.VERSION_NAME)
            .put("webview", WebView.getCurrentWebViewPackage()?.versionName ?: "")
    }

    /** Rows for the search screen: what was typed, matching history, then engine suggestions. */
    private fun suggest(text: String): JSONArray {
        val query = text.trim().take(200)
        val out = JSONArray()
        if (query.isEmpty()) return out
        val engineId = settings.choice("searchEngine")
        fun row(type: String, label: String, detail: String, url: String) =
            out.put(JSONObject().put("type", type).put("text", label).put("detail", detail).put("url", url))

        val direct = Urls.typedUrl(query)
        if (direct != null) row("url", query, "Open address", direct)
        else row("search", query, "Search with ${Search.engine(engineId).name}", Search.searchUrl(engineId, query))
        if (active?.isPrivate != true) {
            for ((url, title) in store.suggest(query, 4)) if (url != direct) row("history", title.ifEmpty { url }, Urls.hostOf(url), url)
        }
        if (settings.toggle("suggestions")) {
            for (phrase in Search.suggest(engineId, query)) row("search", phrase, "", Search.searchUrl(engineId, phrase))
        }
        return out
    }

    private fun clearData(options: JSONObject) {
        if (options.optBoolean("history")) store.clear(options.optLong("since"))
        onMain {
            if (options.optBoolean("cookies")) {
                CookieManager.getInstance().removeAllCookies(null)
                WebStorage.getInstance().deleteAllData()
            }
            if (options.optBoolean("cache")) (tabs.firstNotNullOfOrNull { it.webView } ?: panel).clearCache(true)
        }
    }

    // ----------------------------------------------------------------- back

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val tab = active
        val webView = tab?.webView
        when {
            fullscreenView != null -> exitFullscreen()
            panelRoute != null && panelRoute != "newtab" -> hidePanel()
            tab != null && tab.readerOf != null -> exitReader(tab)
            webView != null && webView.canGoBack() -> webView.goBack()
            tab != null && tabs.size > 1 -> closeTab(tab)
            else -> moveTaskToBack(true)
        }
    }

    companion object {
        private const val TAG = "Buzz"
        private const val PANEL_BASE = "file:///android_asset/ui/"
        private const val PRIVATE_PROFILE = "buzz-private"
        private const val READER_HOST = "reader.buzz.invalid"
        private const val NEW_WINDOW_URL = "about:blank"
        private const val REQUEST_FILE = 1
        private const val LIVE_TABS_SAVER = 3
        private const val LIVE_TABS_MAX = 8
        private val INTERNAL_SCHEMES = setOf("about", "data", "blob", "javascript")
        private val SCREENS = setOf("newtab", "tabs", "history", "downloads", "settings", "shields")
        private val FONT_NAME = Regex("^[a-z0-9-]+\\.woff2$")
    }
}
