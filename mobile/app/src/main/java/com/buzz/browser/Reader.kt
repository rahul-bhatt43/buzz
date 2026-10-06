package com.buzz.browser

import android.content.Context
import org.json.JSONObject
import org.json.JSONTokener

/** Reader mode: pull the article out of a page with Mozilla's Readability and restyle it. */
object Reader {
    /** The origin reader pages are shown under; requests to it are answered from app assets. */
    const val ORIGIN = "https://reader.buzz.invalid"
    private const val MIN_ARTICLE_CHARS = 400

    private var extractScript: String? = null
    private var themeCss: String? = null

    /** JavaScript that returns the article as a JSON string, or null when there is none. */
    fun script(context: Context): String = extractScript ?: run {
        val readability = context.assets.open("vendor/Readability.js").bufferedReader().use { it.readText() }
        """
        (() => {
          $readability
          const article = new Readability(document.cloneNode(true)).parse();
          if (!article) return null;
          return JSON.stringify({
            title: article.title, byline: article.byline, siteName: article.siteName,
            content: article.content, length: article.length, dir: article.dir, lang: article.lang,
          });
        })()
        """.trimIndent().also { extractScript = it }
    }

    /** Decode what WebView.evaluateJavascript returned for [script]. */
    fun parseResult(raw: String?): JSONObject? {
        if (raw == null || raw == "null") return null
        return try {
            val article = JSONObject(JSONTokener(raw).nextValue() as String)
            if (article.optString("content").isEmpty() || article.optInt("length") < MIN_ARTICLE_CHARS) null else article
        } catch (e: Exception) {
            null
        }
    }

    private fun escape(text: String) = text
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;")

    private fun text(article: JSONObject, key: String) = if (article.isNull(key)) "" else article.optString(key)

    /**
     * The reader page. The article HTML comes from the website and is untrusted:
     * the page is shown with JavaScript switched off, and its CSP allows nothing
     * but images, media and the bundled fonts.
     */
    fun page(context: Context, article: JSONObject, url: String, settings: Settings, isPrivate: Boolean): String {
        val theme = themeCss ?: context.assets.open("ui/shared/theme.css").bufferedReader().use { it.readText() }
            .replace("url(\"fonts/", "url(\"$ORIGIN/fonts/").also { themeCss = it }
        val minutes = maxOf(1, Math.round(article.optInt("length") / 1100f))
        val meta = listOf(text(article, "byline"), "$minutes min read").filter { it.isNotEmpty() }.joinToString(" &middot; ") { escape(it) }
        val title = text(article, "title").ifEmpty { Urls.hostOf(url) }
        val site = text(article, "siteName").ifEmpty { Urls.hostOf(url) }
        val dir = text(article, "dir")
        return """
            <!doctype html>
            <html lang="${escape(text(article, "lang").ifEmpty { "en" })}"${if (dir.isEmpty()) "" else " dir=\"${escape(dir)}\""}
              data-scheme="${settings.choice("scheme")}" data-reader-font="${settings.choice("readerFont")}"${if (isPrivate) " class=\"private\"" else ""}>
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src $ORIGIN; img-src https: data:; media-src https:">
            <title>${escape(title)}</title>
            <style>
            $theme
            * { box-sizing: border-box; }
            body { margin: 0; background: var(--chrome); color: var(--ink); font-family: var(--font-reader); font-size: ${settings.choice("readerSize")}px; line-height: 1.7; overflow-wrap: break-word; }
            main { max-width: 43rem; margin: 0 auto; padding: 32px 22px 96px; }
            .site { font: 700 12px/1.4 var(--font-ui); letter-spacing: 0.13em; text-transform: uppercase; color: var(--accent-ink); }
            h1 { margin: 10px 0 14px; font-size: 1.85em; font-weight: 750; line-height: 1.12; letter-spacing: -0.02em; }
            .meta { padding-bottom: 20px; margin-bottom: 26px; border-bottom: 1px solid var(--line); font: 500 14px/1.4 var(--font-ui); color: var(--muted); }
            a { color: var(--accent-ink); text-underline-offset: 3px; }
            p { margin: 0 0 1.15em; }
            h2, h3, h4 { line-height: 1.22; margin: 1.7em 0 0.6em; }
            img, video, svg { max-width: 100%; height: auto; border-radius: 8px; }
            figure { margin: 1.5em 0; }
            figcaption { font: 500 14px/1.45 var(--font-ui); color: var(--muted); margin-top: 8px; }
            blockquote { margin: 1.4em 0; padding-left: 18px; border-left: 3px solid var(--accent); color: var(--muted); font-style: italic; }
            pre { overflow-x: auto; padding: 14px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; font-size: 0.8em; line-height: 1.5; }
            code { font-family: var(--font-mono); font-size: 0.86em; }
            table { display: block; overflow-x: auto; border-collapse: collapse; font-size: 0.9em; }
            td, th { border: 1px solid var(--line); padding: 6px 10px; }
            </style>
            </head>
            <body><main>
            <div class="site">${escape(site)}</div>
            <h1>${escape(title)}</h1>
            <div class="meta">$meta</div>
            <article>${article.optString("content")}</article>
            </main></body>
            </html>
        """.trimIndent()
    }
}
