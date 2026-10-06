package com.buzz.browser

import android.os.Bundle
import android.webkit.WebView
import java.util.concurrent.atomic.AtomicInteger

/**
 * One browser tab. The WebView (and its renderer memory) only exists while the
 * tab is awake; a sleeping tab keeps just its address, title and saved history.
 */
class Tab(val id: Int, val isPrivate: Boolean) {
    var webView: WebView? = null
    var savedState: Bundle? = null

    /** The page's address; empty for a new tab that has not gone anywhere yet. */
    @Volatile var url: String = ""
    var title: String = ""
    var icon: String? = null
    var loading = false
    var progress = 0
    var lastActive = System.currentTimeMillis()

    /** When showing the reader view: the article's real address. */
    @Volatile var readerOf: String? = null

    val blocked = AtomicInteger(0)
    var visitId = 0L
    var visitUrl = ""

    /** Set while Buzz is asking whether to open this plain-HTTP address after a failed HTTPS upgrade. */
    @Volatile var insecurePending: String? = null

    val isBlank: Boolean get() = url.isEmpty()
    val isAsleep: Boolean get() = webView == null && !isBlank

    /** The address to show and act on (the article's, when in reader view). */
    val displayUrl: String get() = insecurePending ?: readerOf ?: url
}
