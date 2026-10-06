package com.buzz.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BlockListTest {
    private val rules = """
        [Adblock Plus 2.0]
        ! a comment
        ||doubleclick.net^
        ||google-analytics.com^${'$'}third-party
        ||tracker.example^${'$'}3p,important
        ||only-scripts.example^${'$'}script
        ||scoped.example^${'$'}domain=news.example
        ||first-party-only.example^${'$'}~third-party
        ||path.example/ads/
        ||wild*.example^
        @@||cdn.doubleclick.net^
        /banner/*
        ##.ad-slot
        example.org##.sponsored
    """.trimIndent()

    private val list = BlockList.parse(rules.lineSequence())

    @Test
    fun onlyWholeHostRulesAreKept() {
        assertEquals(3, list.size)
    }

    @Test
    fun thirdPartyRequestsToListedHostsAreBlocked() {
        assertTrue(list.shouldBlock("doubleclick.net", "news.example"))
        assertTrue(list.shouldBlock("googleads.g.doubleclick.net", "news.example"))
        assertTrue(list.shouldBlock("www.google-analytics.com", "shop.example.co.uk"))
        assertTrue(list.shouldBlock("tracker.example", "news.example.org"))
    }

    @Test
    fun unlistedAndSkippedRulesDoNotBlock() {
        assertFalse(list.shouldBlock("cdn.news.example", "news.example"))
        assertFalse(list.shouldBlock("only-scripts.example", "news.example"))
        assertFalse(list.shouldBlock("scoped.example", "news.example"))
        assertFalse(list.shouldBlock("first-party-only.example", "news.example"))
        assertFalse(list.shouldBlock("path.example", "news.example"))
        // A listed host must match on a label boundary, not as a substring.
        assertFalse(list.shouldBlock("notdoubleclick.net", "news.example"))
    }

    @Test
    fun aSitesOwnRequestsAreNeverBlocked() {
        assertFalse(list.shouldBlock("stats.doubleclick.net", "www.doubleclick.net"))
        assertFalse(list.shouldBlock("tracker.example", "tracker.example"))
    }

    @Test
    fun exceptionRulesWin() {
        assertFalse(list.shouldBlock("cdn.doubleclick.net", "news.example"))
        assertFalse(list.shouldBlock("a.cdn.doubleclick.net", "news.example"))
        assertTrue(list.shouldBlock("ad.doubleclick.net", "news.example"))
    }

    @Test
    fun cachedFormRoundTrips() {
        val restored = BlockList.deserialize(list.serialize())
        assertEquals(list.size, restored.size)
        assertTrue(restored.shouldBlock("ad.doubleclick.net", "news.example"))
        assertFalse(restored.shouldBlock("cdn.doubleclick.net", "news.example"))
    }

    @Test
    fun emptyListBlocksNothing() {
        assertFalse(BlockList.EMPTY.shouldBlock("doubleclick.net", "news.example"))
    }
}
