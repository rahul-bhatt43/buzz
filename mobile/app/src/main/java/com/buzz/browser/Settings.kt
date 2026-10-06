package com.buzz.browser

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/** User settings, stored in SharedPreferences. Only validated values are accepted from the UI. */
class Settings(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("buzz", Context.MODE_PRIVATE)

    private val choices = mapOf(
        "theme" to listOf("system", "light", "dark"),
        "scheme" to listOf("honey", "clover", "lagoon", "poppy", "heather", "graphite"),
        "uiFont" to listOf("figtree", "system", "atkinson", "mono"),
        "readerFont" to listOf("serif", "sans", "atkinson", "mono"),
        "readerSize" to listOf("16", "17", "19", "21", "24"),
        "searchEngine" to Search.ENGINES.map { it.id },
    )
    private val toggles = mapOf("suggestions" to true, "adblock" to true, "httpsUpgrade" to true, "memorySaver" to true)

    // Defaults are the first option unless listed here.
    private val defaults = mapOf("readerSize" to "19")

    fun choice(key: String): String {
        val allowed = choices.getValue(key)
        return prefs.getString(key, null)?.takeIf { it in allowed } ?: defaults[key] ?: allowed[0]
    }

    fun toggle(key: String): Boolean = prefs.getBoolean(key, toggles.getValue(key))

    /** A change requested by the UI. Returns false when the key or value is not allowed. */
    fun setFromUser(key: String, value: Any?): Boolean {
        when {
            key in choices && value?.toString() in choices.getValue(key) -> prefs.edit().putString(key, value.toString()).apply()
            key in toggles && value is Boolean -> prefs.edit().putBoolean(key, value).apply()
            else -> return false
        }
        return true
    }

    fun toJson(): JSONObject = JSONObject().apply {
        for (key in choices.keys) put(key, choice(key))
        for (key in toggles.keys) put(key, toggle(key))
    }

    // ------------------------------------------------------- per-site shields

    fun shieldsOffHosts(): Set<String> = prefs.getStringSet("shieldsOffHosts", emptySet()) ?: emptySet()

    fun setSiteShields(host: String, enabled: Boolean) {
        val hosts = HashSet(shieldsOffHosts())
        if (enabled) hosts.remove(host) else hosts.add(host)
        prefs.edit().putStringSet("shieldsOffHosts", hosts).apply()
    }

    // ---------------------------------------------------------- saved state

    var totalBlocked: Int
        get() = prefs.getInt("totalBlocked", 0)
        set(value) = prefs.edit().putInt("totalBlocked", value).apply()

    /** The toolbar colours last reported by the UI, so the next launch starts in the right theme. */
    var palette: String?
        get() = prefs.getString("palette", null)
        set(value) = prefs.edit().putString("palette", value).apply()

    /** Open (non-private) tabs, restored on the next launch: [{url, title}], plus the active index. */
    fun saveSession(tabs: JSONArray, active: Int) {
        prefs.edit().putString("session", tabs.toString()).putInt("sessionActive", active).apply()
    }

    fun session(): Pair<JSONArray, Int> = try {
        JSONArray(prefs.getString("session", "[]")) to prefs.getInt("sessionActive", 0)
    } catch (e: Exception) {
        JSONArray() to 0
    }
}
