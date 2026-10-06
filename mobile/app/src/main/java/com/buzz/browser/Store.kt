package com.buzz.browser

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

/** Browsing history in SQLite. Private tabs never write here. */
class Store(context: Context) : SQLiteOpenHelper(context, "buzz.db", null, 1) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE visits (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', " +
                "host TEXT NOT NULL DEFAULT '', time INTEGER NOT NULL)",
        )
        db.execSQL("CREATE INDEX visits_time ON visits (time)")
        db.execSQL("CREATE INDEX visits_host ON visits (host)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

    /** Drop entries older than 90 days. */
    fun prune() {
        writableDatabase.delete("visits", "time < ?", arrayOf((System.currentTimeMillis() - 90L * DAY_MS).toString()))
    }

    fun addVisit(url: String, title: String): Long {
        val values = ContentValues().apply {
            put("url", url)
            put("title", title)
            put("host", Urls.hostOf(url))
            put("time", System.currentTimeMillis())
        }
        return writableDatabase.insert("visits", null, values)
    }

    fun setTitle(id: Long, title: String) {
        writableDatabase.update("visits", ContentValues().apply { put("title", title) }, "id = ?", arrayOf(id.toString()))
    }

    fun remove(id: Long) {
        writableDatabase.delete("visits", "id = ?", arrayOf(id.toString()))
    }

    fun clear(since: Long) {
        writableDatabase.delete("visits", "time >= ?", arrayOf(since.toString()))
    }

    // LIKE pattern matching `text` anywhere, with its own wildcards escaped.
    private fun like(text: String) = "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"

    fun query(text: String, before: Long, limit: Int): JSONArray {
        val cutoff = if (before > 0) before else Long.MAX_VALUE
        val (where, args) = if (text.isEmpty()) {
            "time < ?" to arrayOf(cutoff.toString())
        } else {
            "time < ? AND (url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')" to arrayOf(cutoff.toString(), like(text), like(text))
        }
        val out = JSONArray()
        readableDatabase.rawQuery("SELECT id, url, title, time FROM visits WHERE $where ORDER BY time DESC LIMIT $limit", args).use { c ->
            while (c.moveToNext()) {
                out.put(JSONObject().put("id", c.getLong(0)).put("url", c.getString(1)).put("title", c.getString(2)).put("time", c.getLong(3)))
            }
        }
        return out
    }

    /** Pages matching what is being typed, most visited first; hosts that start with the text win. */
    fun suggest(text: String, limit: Int): List<Pair<String, String>> {
        val pattern = like(text)
        val out = ArrayList<Pair<String, String>>()
        readableDatabase.rawQuery(
            "SELECT url, MAX(title), COUNT(*) AS visits, MAX(time) AS last FROM visits " +
                "WHERE url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' " +
                "GROUP BY url ORDER BY (host LIKE ? ESCAPE '\\') DESC, visits DESC, last DESC LIMIT $limit",
            arrayOf(pattern, pattern, pattern.substring(1)),
        ).use { c ->
            while (c.moveToNext()) out.add(c.getString(0) to c.getString(1))
        }
        return out
    }

    fun topSites(limit: Int): JSONArray {
        val out = JSONArray()
        readableDatabase.rawQuery(
            "SELECT host, MIN(url), COUNT(*) AS visits FROM visits WHERE host != '' " +
                "GROUP BY host ORDER BY visits DESC, MAX(time) DESC LIMIT $limit",
            null,
        ).use { c ->
            while (c.moveToNext()) {
                val url = c.getString(1)
                val origin = url.substringBefore("://") + "://" + Urls.rawHost(url) + "/"
                out.put(JSONObject().put("host", c.getString(0)).put("url", origin))
            }
        }
        return out
    }

    companion object {
        private const val DAY_MS = 24L * 60 * 60 * 1000
    }
}
