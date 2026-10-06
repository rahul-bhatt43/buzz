package com.buzz.browser

/** URL helpers. Pure Kotlin (no Android classes) so they run in plain unit tests. */
object Urls {
    private val HOST = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/?#@]*@)?(\\[[^\\]]+]|[^/?#:]*)")
    private val SCHEME = Regex("^(https?|file)://", RegexOption.IGNORE_CASE)
    private val DOMAIN = Regex("^[a-z0-9-]+(\\.[a-z0-9-]+)*\\.[a-z]{2,}$", RegexOption.IGNORE_CASE)
    private val IPV4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.\\d{1,3}\\.\\d{1,3}$")

    // Second-level labels that act like a TLD ("example.co.uk" is one site, not "co.uk").
    private val PUBLIC_SECOND_LEVEL = setOf("co", "com", "org", "net", "gov", "edu", "ac")

    /** The exact host of a URL, lower-cased; empty when there is none. */
    fun rawHost(url: String): String = (HOST.find(url)?.groupValues?.get(1) ?: "").lowercase()

    /** The host as shown to people: without a leading "www.". */
    fun hostOf(url: String): String = rawHost(url).removePrefix("www.")

    fun isWebUrl(url: String?): Boolean =
        url != null && (url.startsWith("http://", true) || url.startsWith("https://", true))

    /** Hosts that never get an HTTPS upgrade: loopback, private ranges and local names. */
    fun isLocalHost(hostname: String): Boolean {
        val h = hostname.trim('[', ']').lowercase()
        if (h == "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true
        if (h.contains(':')) return h == "::1" || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")
        val m = IPV4.find(h) ?: return false
        val a = m.groupValues[1].toInt()
        val b = m.groupValues[2].toInt()
        return a == 127 || a == 10 || (a == 192 && b == 168) || (a == 172 && b in 16..31) || (a == 169 && b == 254)
    }

    /** The URL typed text stands for, or null when it reads as a search query. */
    fun typedUrl(input: String): String? {
        val text = input.trim()
        if (text.isEmpty()) return null
        if (SCHEME.containsMatchIn(text)) return text
        if (text.any { it.isWhitespace() }) return null
        val hostPart = text.split('/', '?', '#')[0]
        val bareHost = hostPart.replace(Regex(":\\d+$"), "")
        if (isLocalHost(bareHost)) return "http://$text"
        if (DOMAIN.matches(bareHost)) return "https://$text"
        return null
    }

    /** Turn whatever was typed in the address bar into a URL to load. */
    fun fromAddressInput(input: String, searchUrl: (String) -> String): String? {
        val text = input.trim()
        if (text.isEmpty()) return null
        return typedUrl(text) ?: searchUrl(text)
    }

    /** The part of a host that identifies the site: "ads.example.co.uk" -> "example.co.uk". */
    fun registrableDomain(host: String): String {
        val labels = host.lowercase().trim('.').split('.')
        if (labels.size <= 2 || IPV4.matches(host)) return host.lowercase()
        val tld = labels.last()
        val second = labels[labels.size - 2]
        val take = if (tld.length == 2 && second in PUBLIC_SECOND_LEVEL) 3 else 2
        return labels.takeLast(take).joinToString(".")
    }

    /** "http://example.com/a" -> "https://example.com/a" when the site is a candidate for upgrading. */
    fun httpsUpgrade(url: String): String? {
        if (!url.startsWith("http://", true)) return null
        val host = rawHost(url)
        if (host.isEmpty() || isLocalHost(host)) return null
        // Only the default port is upgraded; a custom port rarely serves TLS as well.
        val afterHost = url.substring("http://".length).substringAfter(host, "")
        if (afterHost.startsWith(":")) return null
        return "https://" + url.substring("http://".length)
    }
}
