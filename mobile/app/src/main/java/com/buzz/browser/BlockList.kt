package com.buzz.browser

/**
 * Ad and tracker blocking by host. Built from the domain rules of standard
 * filter lists ("||tracker.example^"); a request is blocked when it goes to a
 * listed host from a page on a different site.
 *
 * Pure Kotlin so the matching logic runs in plain unit tests.
 */
class BlockList(private val blocked: Set<String>, private val allowed: Set<String>) {

    val size: Int get() = blocked.size

    fun shouldBlock(requestHost: String, pageHost: String): Boolean {
        if (requestHost.isEmpty() || pageHost.isEmpty() || blocked.isEmpty()) return false
        // A site's own requests are never blocked, so visiting a listed site still works.
        if (Urls.registrableDomain(requestHost) == Urls.registrableDomain(pageHost)) return false
        val candidates = suffixes(requestHost)
        if (candidates.any { it in allowed }) return false
        return candidates.any { it in blocked }
    }

    /** Compact form for caching: one host per line, "+" blocked, "-" allowed. */
    fun serialize(): String = buildString {
        for (host in blocked) append('+').append(host).append('\n')
        for (host in allowed) append('-').append(host).append('\n')
    }

    companion object {
        val EMPTY = BlockList(emptySet(), emptySet())

        // Options that leave a rule a plain "block this host" rule. Anything else
        // (resource types, domain= limits, first-party-only) is skipped rather than guessed at.
        private val PLAIN_OPTIONS = setOf("third-party", "3p", "all", "important", "document", "doc")
        private val HOST = Regex("^[a-z0-9.-]+$")

        /** "a.b.example.com" -> [a.b.example.com, b.example.com, example.com] */
        fun suffixes(host: String): List<String> {
            val out = ArrayList<String>(4)
            var current = host
            while (current.contains('.')) {
                out.add(current)
                current = current.substringAfter('.')
            }
            return out
        }

        /** Parse filter-list text (EasyList syntax), keeping only whole-host rules. */
        fun parse(lines: Sequence<String>): BlockList {
            val blocked = HashSet<String>()
            val allowed = HashSet<String>()
            for (raw in lines) {
                val line = raw.trim()
                val exception = line.startsWith("@@||")
                if (!exception && !line.startsWith("||")) continue
                val rule = line.substring(if (exception) 4 else 2)
                val caret = rule.indexOf('^')
                if (caret <= 0) continue
                val host = rule.substring(0, caret)
                val rest = rule.substring(caret + 1)
                if (!host.contains('.') || !HOST.matches(host)) continue
                if (rest.isNotEmpty()) {
                    if (!rest.startsWith("$")) continue
                    if (!rest.substring(1).split(',').all { it in PLAIN_OPTIONS }) continue
                }
                (if (exception) allowed else blocked).add(host)
            }
            return BlockList(blocked, allowed)
        }

        fun deserialize(text: String): BlockList {
            val blocked = HashSet<String>()
            val allowed = HashSet<String>()
            for (line in text.lineSequence()) {
                if (line.length < 2) continue
                when (line[0]) {
                    '+' -> blocked.add(line.substring(1))
                    '-' -> allowed.add(line.substring(1))
                }
            }
            return BlockList(blocked, allowed)
        }
    }
}
