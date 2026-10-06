package com.buzz.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlsTest {
    private val search = { query: String -> Search.searchUrl("duckduckgo", query) }

    @Test
    fun addressInputBecomesUrlOrSearch() {
        val cases = mapOf(
            "example.com" to "https://example.com",
            "example.com/a?b=1" to "https://example.com/a?b=1",
            "http://example.com" to "http://example.com",
            "localhost:3000" to "http://localhost:3000",
            "192.168.1.10/admin" to "http://192.168.1.10/admin",
            "how do bees fly" to "https://duckduckgo.com/?q=how%20do%20bees%20fly",
            "node.js" to "https://node.js",
            "bees" to "https://duckduckgo.com/?q=bees",
        )
        for ((input, expected) in cases) assertEquals(input, expected, Urls.fromAddressInput(input, search))
        assertNull(Urls.fromAddressInput("   ", search))
    }

    @Test
    fun searchUsesTheChosenEngine() {
        assertEquals("https://search.brave.com/search?q=honey%20bee", Search.searchUrl("brave", "honey bee"))
        assertEquals("https://www.startpage.com/sp/search?query=a%26b", Search.searchUrl("startpage", "a&b"))
        assertEquals("https://duckduckgo.com/?q=x", Search.searchUrl("no-such-engine", "x"))
    }

    @Test
    fun hostsAreExtracted() {
        assertEquals("example.com", Urls.hostOf("https://www.example.com/path?q=1"))
        assertEquals("www.example.com", Urls.rawHost("https://www.example.com:8443/"))
        assertEquals("example.com", Urls.hostOf("https://user:pass@EXAMPLE.com/"))
        assertEquals("", Urls.hostOf("not a url"))
    }

    @Test
    fun registrableDomainGroupsSubdomains() {
        assertEquals("example.com", Urls.registrableDomain("ads.cdn.example.com"))
        assertEquals("example.co.uk", Urls.registrableDomain("shop.example.co.uk"))
        assertEquals("example.com", Urls.registrableDomain("example.com"))
        assertEquals("10.0.0.7", Urls.registrableDomain("10.0.0.7"))
    }

    @Test
    fun httpsUpgradeSkipsLocalAndCustomPorts() {
        assertEquals("https://example.com/a?b#c", Urls.httpsUpgrade("http://example.com/a?b#c"))
        assertEquals("https://example.com", Urls.httpsUpgrade("http://example.com"))
        assertNull(Urls.httpsUpgrade("https://example.com/"))
        assertNull(Urls.httpsUpgrade("http://example.com:8080/"))
        assertNull(Urls.httpsUpgrade("http://localhost/"))
        assertNull(Urls.httpsUpgrade("http://192.168.1.1/"))
        assertNull(Urls.httpsUpgrade("http://printer.local/"))
    }

    @Test
    fun localHostsAreRecognised() {
        assertTrue(Urls.isLocalHost("127.0.0.1"))
        assertTrue(Urls.isLocalHost("172.20.1.1"))
        assertTrue(Urls.isLocalHost("[::1]"))
        assertFalse(Urls.isLocalHost("172.40.1.1"))
        assertFalse(Urls.isLocalHost("fcbarcelona.com"))
    }
}
