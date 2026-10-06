package com.buzz.browser

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** Buzz Shields: the loaded block list plus the state behind HTTPS upgrades. */
object Shields {
    private const val TAG = "BuzzShields"
    private const val CACHE_FILE = "blocklist.txt"
    private const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000
    private val SOURCES = listOf(
        "https://easylist.to/easylist/easylist.txt",
        "https://easylist.to/easylist/easyprivacy.txt",
    )

    @Volatile var list: BlockList = BlockList.EMPTY
        private set

    /** loading | ready | unavailable */
    @Volatile var state: String = "loading"
        private set

    val totalBlocked = AtomicInteger(0)

    // tab id -> (host, original http URL) of the last HTTPS upgrade made in that tab
    private val upgraded = ConcurrentHashMap<Int, Pair<String, String>>()

    // hosts the user chose to open over HTTP (this run only)
    private val insecureAllowed: MutableSet<String> = ConcurrentHashMap.newKeySet()

    /** Load the cached list, refreshing it from the network about once a week. */
    fun load(context: Context, onChange: () -> Unit) {
        val cache = File(context.filesDir, CACHE_FILE)
        thread(name = "buzz-shields", isDaemon = true) {
            try {
                if (cache.exists()) {
                    list = BlockList.deserialize(cache.readText())
                    state = "ready"
                    onChange()
                }
                if (!cache.exists() || System.currentTimeMillis() - cache.lastModified() > MAX_AGE_MS) {
                    val fresh = BlockList.parse(SOURCES.asSequence().flatMap { download(it).lineSequence() })
                    if (fresh.size > 0) {
                        cache.writeText(fresh.serialize())
                        list = fresh
                        state = "ready"
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Filter lists could not be loaded: ${e.message}")
            }
            if (state != "ready") state = "unavailable"
            onChange()
        }
    }

    private fun download(address: String): String {
        val connection = URL(address).openConnection() as HttpURLConnection
        connection.connectTimeout = 15000
        connection.readTimeout = 30000
        try {
            return connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    /**
     * The HTTPS address to load instead of [url], or null to leave it alone.
     * Remembers the upgrade so a failed load can offer the HTTP site again.
     */
    fun upgrade(tabId: Int, url: String): String? {
        val https = Urls.httpsUpgrade(url) ?: return null
        val host = Urls.rawHost(url)
        if (host in insecureAllowed) return null
        upgraded[tabId] = host to url
        return https
    }

    /** If [failedUrl] is an upgrade made in this tab, the original HTTP URL. */
    fun fallbackFor(tabId: Int, failedUrl: String): String? {
        val (host, httpUrl) = upgraded[tabId] ?: return null
        return if (failedUrl.startsWith("https://") && Urls.rawHost(failedUrl) == host) httpUrl else null
    }

    /** True when [url] is plain HTTP on the host this tab was just upgraded away from. */
    fun isDowngrade(tabId: Int, url: String): Boolean =
        url.startsWith("http://") && upgraded[tabId]?.first == Urls.rawHost(url) && Urls.rawHost(url) !in insecureAllowed

    fun allowInsecure(url: String) {
        insecureAllowed.add(Urls.rawHost(url))
    }

    fun forgetTab(tabId: Int) {
        upgraded.remove(tabId)
    }
}
