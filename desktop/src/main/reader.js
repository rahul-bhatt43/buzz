// Reader mode: pull the article out of a page with Mozilla's Readability.
const fs = require('node:fs');

const READABILITY_SRC = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8');
const READERABLE_SRC = fs.readFileSync(require.resolve('@mozilla/readability/Readability-readerable.js'), 'utf8');

// Scripts run in an isolated world so the page cannot tamper with the parser.
const WORLD_ID = 4711;
const MAX_ARTICLES = 20;
const MIN_ARTICLE_CHARS = 400;

const EXTRACT_SCRIPT = `(() => {
  ${READABILITY_SRC}
  const article = new Readability(document.cloneNode(true)).parse();
  if (!article) return null;
  return {
    title: article.title, byline: article.byline, siteName: article.siteName,
    content: article.content, length: article.length, dir: article.dir, lang: article.lang,
  };
})()`;

const READERABLE_SCRIPT = `(() => {
  ${READERABLE_SRC}
  return isProbablyReaderable(document);
})()`;

const articlesBySession = new WeakMap(); // session -> Map(url -> article)

async function extract(wc) {
  try {
    const article = await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: EXTRACT_SCRIPT }]);
    if (!article || !article.content || (article.length || 0) < MIN_ARTICLE_CHARS) return null;
    return article;
  } catch {
    return null;
  }
}

async function isReaderable(wc) {
  try {
    return (await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: READERABLE_SCRIPT }])) === true;
  } catch {
    return false;
  }
}

function store(ses, url, article) {
  let articles = articlesBySession.get(ses);
  if (!articles) {
    articles = new Map();
    articlesBySession.set(ses, articles);
  }
  articles.delete(url);
  articles.set(url, article);
  if (articles.size > MAX_ARTICLES) articles.delete(articles.keys().next().value);
}

function get(ses, url) {
  const articles = articlesBySession.get(ses);
  return articles ? articles.get(url) || null : null;
}

function readerUrl(url) {
  return 'buzz://reader/?url=' + encodeURIComponent(url);
}

module.exports = { extract, isReaderable, store, get, readerUrl };
