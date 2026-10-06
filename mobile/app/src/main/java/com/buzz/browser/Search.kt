package com.buzz.browser

import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Search engines: where a query goes, and where its suggestions come from. */
object Search {
    class Engine(val id: String, val name: String, val search: String, val suggest: String)

    val ENGINES = listOf(
        Engine("duckduckgo", "DuckDuckGo", "https://duckduckgo.com/?q=%s", "https://duckduckgo.com/ac/?type=list&q=%s"),
        Engine("google", "Google", "https://www.google.com/search?q=%s", "https://suggestqueries.google.com/complete/search?client=firefox&q=%s"),
        Engine("bing", "Bing", "https://www.bing.com/search?q=%s", "https://api.bing.com/osjson.aspx?query=%s"),
        Engine("brave", "Brave Search", "https://search.brave.com/search?q=%s", "https://search.brave.com/api/suggest?q=%s"),
        Engine("startpage", "Startpage", "https://www.startpage.com/sp/search?query=%s", "https://www.startpage.com/osuggestions?q=%s"),
        Engine("ecosia", "Ecosia", "https://www.ecosia.org/search?q=%s", "https://ac.ecosia.org/autocomplete?type=list&q=%s"),
    )

    private const val MAX_SUGGESTIONS = 6

    fun engine(id: String): Engine = ENGINES.firstOrNull { it.id == id } ?: ENGINES[0]

    private fun encode(query: String) = URLEncoder.encode(query, "UTF-8").replace("+", "%20")

    fun searchUrl(engineId: String, query: String): String = engine(engineId).search.replace("%s", encode(query))

    /** Query suggestions from the engine. Blocking: call off the main thread. */
    fun suggest(engineId: String, query: String): List<String> {
        if (query.isEmpty()) return emptyList()
        return try {
            val connection = URL(engine(engineId).suggest.replace("%s", encode(query))).openConnection() as HttpURLConnection
            connection.connectTimeout = 2500
            connection.readTimeout = 2500
            val body = try {
                connection.inputStream.bufferedReader().use { it.readText() }
            } finally {
                connection.disconnect()
            }
            val phrases = JSONArray(body).optJSONArray(1) ?: return emptyList()
            (0 until phrases.length()).mapNotNull { phrases.optString(it).takeIf { p -> p.isNotEmpty() && p != query } }.take(MAX_SUGGESTIONS)
        } catch (e: Exception) {
            emptyList()
        }
    }
}
