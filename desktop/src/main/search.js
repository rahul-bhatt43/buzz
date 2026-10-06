// Search engines: where a query goes, and where its suggestions come from.
const settings = require('./settings');

const ENGINES = {
  duckduckgo: {
    name: 'DuckDuckGo',
    search: 'https://duckduckgo.com/?q=%s',
    suggest: 'https://duckduckgo.com/ac/?type=list&q=%s',
  },
  google: {
    name: 'Google',
    search: 'https://www.google.com/search?q=%s',
    suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&q=%s',
  },
  bing: {
    name: 'Bing',
    search: 'https://www.bing.com/search?q=%s',
    suggest: 'https://api.bing.com/osjson.aspx?query=%s',
  },
  brave: {
    name: 'Brave Search',
    search: 'https://search.brave.com/search?q=%s',
    suggest: 'https://search.brave.com/api/suggest?q=%s',
  },
  startpage: {
    name: 'Startpage',
    search: 'https://www.startpage.com/sp/search?query=%s',
    suggest: 'https://www.startpage.com/osuggestions?q=%s',
  },
  ecosia: {
    name: 'Ecosia',
    search: 'https://www.ecosia.org/search?q=%s',
    suggest: 'https://ac.ecosia.org/autocomplete?type=list&q=%s',
  },
};

const SUGGEST_TIMEOUT_MS = 2500;
const MAX_SUGGESTIONS = 6;

function current() {
  return ENGINES[settings.get('searchEngine')] || ENGINES.duckduckgo;
}

function searchUrl(query, engineId) {
  const engine = (engineId && ENGINES[engineId]) || current();
  return engine.search.replace('%s', encodeURIComponent(query));
}

// For a plain HTML search form: the action URL and the query parameter name.
function form() {
  const url = new URL(current().search.replace('%s', ''));
  const param = [...url.searchParams.keys()].pop();
  return { action: url.origin + url.pathname, origin: url.origin, param };
}

function list() {
  return Object.entries(ENGINES).map(([id, engine]) => ({ id, name: engine.name }));
}

// Query suggestions from the current engine, fetched through `ses` without cookies.
async function suggest(ses, query) {
  if (!settings.get('suggestions') || !query) return [];
  try {
    const res = await ses.fetch(current().suggest.replace('%s', encodeURIComponent(query)), {
      credentials: 'omit',
      signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = JSON.parse(await res.text());
    const phrases = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
    return phrases.filter((p) => typeof p === 'string' && p && p !== query).slice(0, MAX_SUGGESTIONS);
  } catch {
    return [];
  }
}

module.exports = { current, searchUrl, form, list, suggest };
