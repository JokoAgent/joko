/**
 * Built-in browser knowledge kept as capability-neutral product data.
 *
 * The bridge validates every entry before exposing it. Keeping the catalog
 * static guarantees that production never reads development-only files.
 */
import {
  DOUBAN_EMPTY_RESULTS_TEXT,
  DOUBAN_VERIFICATION_TEXT,
  FACEBOOK_SIGN_IN_TEXT,
  JD_PRODUCT_CODE_LABEL,
  JD_SPECIFICATIONS_SECTION,
  XIAOHONGSHU_SIGN_IN_TEXT
} from "./i18n/browser-site-language.js";

export const BUILTIN_BROWSER_RECIPES: readonly unknown[] = [{
  "id": "36kr-news",
  "match": ["36kr.com"],
  "description": "Read the latest 36Kr technology and venture-capital headlines from the public www.36kr.com/feed RSS feed without signing in. The output is RSS XML; parse each <item> for title, link, pubDate, and description.",
  "inputs": {},
  "steps": [
    { "action": "navigate", "url": "https://www.36kr.com/feed" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "feed", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{feed}}"
},{
  "id": "x-tweet",
  "match": ["api.fxtwitter.com", "x.com", "twitter.com"],
  "description": "Read one public X (Twitter) post through the public FxTwitter API without signing in or an API key. Returns text, author, engagement, media, and quoted content. Pass the numeric post ID from /status/ as a string: 19-digit IDs exceed JSON's safe integer range. Private and deleted posts are unavailable. Timelines and search require the authenticated x.com workflow in its site guide.",
  "inputs": { "id": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://api.fxtwitter.com/status/{{id|url}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "tweet",
      "fn": "() => { let d; try { d = JSON.parse(document.body.innerText); } catch (e) { throw new Error('FxTwitter returned non-JSON content, possibly due to a network block or service failure. Page begins: ' + document.body.innerText.slice(0, 200)); } if (!d.tweet) throw new Error('Post not found (code ' + d.code + ' ' + d.message + '). Check the ID; private and deleted posts are unavailable. Pass the ID as a string because JSON numbers lose precision for 19-digit IDs.'); const t = d.tweet; if (String(t.id) !== '{{id|js}}') throw new Error('Returned post ID (' + t.id + ') differs from requested ID ({{id|js}}). A numeric ID may have lost precision; retry with a string.'); const a = t.author || {}; const m = t.media || {}; const media = (m.photos || []).map(p => ({ type: 'photo', url: p.url })).concat((m.videos || []).map(v => ({ type: v.type || 'video', url: v.url, thumbnail: v.thumbnail_url }))); return { url: t.url, id: t.id, text: t.text, lang: t.lang, created_at: t.created_at, author: { name: a.name, screen_name: a.screen_name, followers: a.followers }, replies: t.replies, retweets: t.retweets, likes: t.likes, quotes: t.quotes, bookmarks: t.bookmarks, views: t.views, replying_to: t.replying_to, media, quote: t.quote ? { text: t.quote.text, author: t.quote.author && t.quote.author.screen_name, url: t.quote.url } : null }; }"
    }
  ],
  "output": "{{tweet}}"
},{
  "id": "arxiv-search",
  "match": ["arxiv.org", "export.arxiv.org"],
  "description": "Search papers through the public arXiv API and return Atom XML containing titles, authors, and abstracts.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://export.arxiv.org/api/query?search_query=all:{{query|url}}&max_results=20&sortBy=relevance" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "barchart-quote",
  "match": ["barchart.com"],
  "description": "Read a Barchart stock quote and key metrics: price, change, open, high, low, previous close, volume, average volume, market cap, P/E, and EPS. Sign in to barchart.com in the persistent browser first. The recipe opens the overview page, then fetches the site's proxy API with its session cookie and page CSRF token. Pass a ticker such as AAPL as symbol.",
  "inputs": { "symbol": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.barchart.com/stocks/quotes/{{symbol}}/overview" },
    { "action": "wait", "loadState": "load" },
    { "action": "evaluate", "as": "quote", "fn": "async () => { const csrf = (document.querySelector('meta[name=\"csrf-token\"]') || {}).content || ''; if (!csrf) throw new Error('Barchart CSRF token is unavailable. Wait for the page to load, sign in to barchart.com in the persistent browser, and retry.'); const fields = ['symbol','symbolName','lastPrice','priceChange','percentChange','openPrice','highPrice','lowPrice','previousPrice','volume','averageVolume','marketCap','peRatio','earningsPerShare','tradeTime'].join(','); const r = await fetch('/proxies/core-api/v1/quotes/get?symbol=' + encodeURIComponent('{{symbol|js}}'.toUpperCase()) + '&fields=' + fields, { credentials: 'include', headers: { 'X-CSRF-TOKEN': csrf } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch(e) { throw new Error('Barchart returned non-JSON content, possibly due to missing authentication or an access challenge. Sign in through the persistent browser and retry.'); } const row = d && d.data && d.data[0]; if (!row) throw new Error('Stock quote unavailable; the symbol may be invalid or the market closed.'); const v = row.raw || row; return { symbol: v.symbol, name: v.symbolName, price: v.lastPrice, change: v.priceChange, changePercent: v.percentChange, open: v.openPrice, high: v.highPrice, low: v.lowPrice, previousClose: v.previousPrice, volume: v.volume, avgVolume: v.averageVolume, marketCap: v.marketCap, peRatio: v.peRatio, eps: v.earningsPerShare, tradeTime: v.tradeTime }; }" }
  ],
  "output": "{{quote}}"
},{
  "id": "bbc-news-feed",
  "match": ["bbc.com", "www.bbc.com", "bbc.co.uk"],
  "description": "Read BBC headlines, summaries, links, and publication dates from its public RSS feeds without signing in. Set section to news, news/world, news/technology, news/business, or sport. Output is RSS XML with title, description, link, and pubDate in each <item>.",
  "inputs": { "section": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://feeds.bbci.co.uk/{{section}}/rss.xml" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "xml", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{xml}}"
},{
  "id": "bilibili-hot",
  "match": ["bilibili.com"],
  "description": "Read popular Bilibili videos with rank, title, creator, views, comment-overlay count, and link. Open bilibili.com first, then fetch JSON within the page with browser cookies. Navigating directly to the API host can return SPA HTML or an access challenge.",
  "inputs": { "limit": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.bilibili.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "videos",
      "fn": "async () => { const r = await fetch('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=' + encodeURIComponent('{{limit|js}}'), { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Bilibili returned non-JSON content, possibly due to an access challenge or missing authentication. Open or sign in to the site in the persistent browser and retry.'); } return (d && d.data && d.data.list ? d.data.list : []).map((v, i) => ({ rank: i + 1, title: v.title, author: v.owner && v.owner.name, play: v.stat && v.stat.view, danmaku: v.stat && v.stat.danmaku, url: v.bvid ? 'https://www.bilibili.com/video/' + v.bvid : '' })); }"
    }
  ],
  "output": "{{videos}}"
},{
  "id": "sinablog-search",
  "match": ["blog.sina.com.cn", "search.sina.com.cn"],
  "description": "Search Sina Blog articles through the public search.sina.com.cn/api/search API without signing in. Returns JSON with title, author, time, summary, and link. Read data.list and retain URLs containing blog.sina.com.cn/s/blog_.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://search.sina.com.cn/api/search?q={{query|url}}&tp=mix&sort=0&page=1&size=20&from=search_result" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "bloomberg-feed",
  "match": ["bloomberg.com"],
  "description": "Read Bloomberg headline metadata from public RSS without signing in: titles, summaries, links, and publication dates. Article bodies require a subscription and are not fetched. Set section to markets, technology, economics, politics, industries, businessweek, or bview. The recipe builds feeds.bloomberg.com/<section>/news.rss. The main feed is the separate feeds.bloomberg.com/news.rss URL; section=news would produce an invalid /news/news.rss path.",
  "inputs": { "section": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://feeds.bloomberg.com/{{section}}/news.rss" },
    { "action": "wait", "loadState": "load" },
    { "action": "evaluate", "as": "items", "fn": "() => { const raw = document.body.innerText || (document.documentElement && document.documentElement.textContent) || ''; if (!/<item[\\s>]/i.test(raw)) throw new Error('Bloomberg RSS contains no items. Check section: markets, technology, economics, politics, industries, businessweek, or bview. Do not use news; the main feed is feeds.bloomberg.com/news.rss. The feed may also be temporarily unavailable.'); const dec = s => String(s || '').replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&#39;/g, \"'\").replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim(); const tag = (block, name) => { const m = block.match(new RegExp('<' + name + '(?:\\\\s[^>]*)?>([\\\\s\\\\S]*?)<\\\\/' + name + '>', 'i')); return m ? dec(m[1]) : ''; }; const out = []; const re = /<item\\b[^>]*>([\\s\\S]*?)<\\/item>/gi; let m; while ((m = re.exec(raw)) && out.length < 20) { const b = m[1]; const title = tag(b, 'title'); const link = tag(b, 'link') || tag(b, 'guid'); if (!title || !link) continue; out.push({ title, summary: tag(b, 'description'), link, pubDate: tag(b, 'pubDate') }); } return out; }" }
  ],
  "output": "{{items}}"
},{
  "id": "books-list",
  "match": ["books.toscrape.com"],
  "description": "List books on a books.toscrape.com listing page, including title, price, and availability. This sample recipe exercises structured extraction.",
  "inputs": { "url": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "{{url}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "extract",
      "as": "books",
      "extract": {
        "from": "article.product_pod",
        "multiple": true,
        "fields": {
          "title": { "selector": "h3 a", "attr": "title" },
          "price": ".price_color",
          "availability": ".availability"
        }
      }
    }
  ],
  "output": "{{books}}"
},{
  "id": "bluesky-user-posts",
  "match": ["bsky.app"],
  "description": "Read an account's latest public Bluesky posts through the public AT Protocol API without signing in. Returns text, likes, reposts, replies, and timestamps. Set username to an account handle such as bsky.app or jay.bsky.team.",
  "inputs": { "username": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor={{username|url}}&limit=25" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "coingecko-search",
  "match": ["coingecko.com"],
  "description": "Search coins, exchanges, and categories by keyword through CoinGecko's public search API and return JSON.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://api.coingecko.com/api/v3/search?query={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "crates-search",
  "match": ["crates.io"],
  "description": "Search Rust crates through the public crates.io API and return JSON with names and descriptions.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://crates.io/api/v1/crates?q={{query|url}}&per_page=20" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "ctrip-suggest",
  "match": ["ctrip.com"],
  "description": "Search Ctrip destination, city, attraction, and hotel suggestions by keyword, including rank, name, type, city, and review score. The public gaHotelSearchEngine endpoint accepts anonymous requests. Open m.ctrip.com first, then make the same-origin POST.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://m.ctrip.com/" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": "async () => { const body = { keyword: '{{query|js}}', searchType: 'D', platform: 'online', pageID: '102001', head: { Locale: 'zh-CN', LocaleController: 'zh_cn', Currency: 'CNY', PageId: '102001', clientID: 'xdt-recipe', group: 'ctrip', Frontend: { sessionID: 1, pvid: 1 }, HotelExtension: { group: 'CTRIP', WebpSupport: false } } }; const r = await fetch('https://m.ctrip.com/restapi/soa2/21881/json/gaHotelSearchEngine', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Ctrip returned non-JSON content, possibly due to an access challenge. Open ctrip.com in the persistent browser and retry.'); } const list = (d && d.Response && Array.isArray(d.Response.searchResults)) ? d.Response.searchResults : []; return list.slice(0, 15).map((it, i) => ({ rank: i + 1, name: String(it.displayName || it.word || it.cityName || '').replace(/\\s+/g, ' ').trim(), type: String(it.displayType || it.type || '').trim(), city: it.cityName || '', score: it.commentScore || it.cStar || '', country: it.countryName || '' })).filter(x => x.name); }"
    }
  ],
  "output": "{{items}}"
},{
  "id": "devto-articles",
  "match": ["dev.to"],
  "description": "Read the latest articles for a tag through the public dev.to Articles API and return a JSON array.",
  "inputs": { "tag": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://dev.to/api/articles?tag={{tag|url}}&per_page=20" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "mdn-search",
  "match": ["developer.mozilla.org"],
  "description": "Search MDN documentation through its public API and return JSON with titles and slugs.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://developer.mozilla.org/api/v1/search?q={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "douban-search",
  "match": ["douban.com", "search.douban.com"],
  "description": "Search Douban movie, book, or music entries. Set type to movie, book, or music. Poll for client-rendered .item-root cards before extracting titles, ratings, summaries, and links.",
  "inputs": { "type": { "required": true }, "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://search.douban.com/{{type}}/subject_search?search_text={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": `async () => { const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const norm=v=>(v||'').replace(/\\s+/g,' ').trim(); for(let i=0;i<20;i++){ if(document.querySelector('.item-root .title-text, .item-root .title a')) break; await sleep(300); } const out=[]; const seen=new Set(); for(const el of document.querySelectorAll('.item-root')){ const t=el.querySelector('.title-text, .title a, a[title]'); const title=norm(t&&t.textContent)||norm(t&&t.getAttribute('title')); let url=(t&&t.getAttribute('href'))||''; if(!title||!url||url.indexOf('/subject/')<0||seen.has(url)) continue; seen.add(url); const rating=norm((el.querySelector('.rating_nums')||{}).textContent); const abs=norm((el.querySelector('.meta.abstract, .meta, .abstract, p')||{}).textContent); out.push({ rank: out.length+1, title: title, rating: rating, abstract: abs.slice(0,100), url: url }); if(out.length>=20) break; } if(!out.length){ const bodyText=document.body&&document.body.innerText||''; if(${DOUBAN_VERIFICATION_TEXT}.test(bodyText)) throw new Error('Douban requires verification. Complete the challenge or sign in through the persistent browser, then retry.'); if(!${DOUBAN_EMPTY_RESULTS_TEXT}.test(bodyText)) throw new Error('Douban returned no extracted entries or recognized empty-result message. The page may still be rendering, have changed structure, or require verification. Open search.douban.com in the persistent browser and retry, or use another method.'); } return out; }`
    }
  ],
  "output": "{{items}}"
},{
  "id": "douyin-user-videos",
  "match": ["douyin.com"],
  "description": "Read a Douyin user's public videos with titles, likes, duration, and video URLs. Open douyin.com, then fetch JSON within the page using browser cookies and request signing. Direct API navigation can return SPA HTML or an access challenge. Set sec_uid to the final segment of https://www.douyin.com/user/<sec_uid>.",
  "inputs": { "sec_uid": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.douyin.com/user/{{sec_uid}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "videos",
      "fn": "async () => { const r = await fetch('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=' + encodeURIComponent('{{sec_uid|js}}') + '&max_cursor=0&count=20&aid=6383', { credentials: 'include', headers: { referer: 'https://www.douyin.com/' } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Douyin returned non-JSON content, possibly due to missing authentication or an access challenge. Sign in to douyin.com in the persistent browser and retry.'); } if (d && d.status_code && d.status_code !== 0) throw new Error('Douyin returned an error status_code=' + d.status_code + ' (possibly an access challenge). Sign in to douyin.com in the persistent browser and retry.'); const list = (d && d.aweme_list) ? d.aweme_list : []; return list.map((v, i) => ({ index: i + 1, aweme_id: v.aweme_id, title: v.desc || '', duration: v.video && v.video.duration ? Math.round(v.video.duration / 1000) : 0, digg: v.statistics && v.statistics.digg_count || 0, play_url: v.video && v.video.play_addr && v.video.play_addr.url_list && v.video.play_addr.url_list[0] || '' })); }"
    }
  ],
  "output": "{{videos}}"
},{
  "id": "facebook-search",
  "match": ["facebook.com"],
  "description": "Search Facebook people, pages, and posts and return coarse title, summary, and link results from rendered role=article elements. Requires a signed-in browser session.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.facebook.com" },
    { "action": "navigate", "url": "https://www.facebook.com/search/top?q={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": `async () => { const sleep=ms=>new Promise(r=>setTimeout(r,ms)); await sleep(4000); const body=document.body&&document.body.innerText||''; if(${FACEBOOK_SIGN_IN_TEXT}.test(body) && !document.querySelector('[role="article"]')) throw new Error('Facebook requires authentication. Sign in through the persistent browser and retry.'); let items=document.querySelectorAll('[role="article"]'); if(!items.length) items=document.querySelectorAll('[role="listitem"]'); return Array.from(items).filter(el=>el.textContent.trim().length>20).slice(0,15).map((el,i)=>{ const link=el.querySelector('a[href*="facebook.com/"]'); const h=el.querySelector('h2, h3, h4, strong'); return { rank: i+1, title: h?h.textContent.trim().slice(0,80):'', text: el.textContent.trim().replace(/\\s+/g,' ').slice(0,150), url: link?link.href.split('?')[0]:'' }; }); }`
    }
  ],
  "output": "{{items}}"
},{
  "id": "sinafinance-news",
  "match": ["finance.sina.com.cn", "app.cj.sina.com.cn"],
  "description": "Read Sina Finance's continuous news updates through the public app.cj.sina.com.cn/api/news/pc API without signing in. Returns JSON with ID, publication time, text, and read count. limit is capped at 50; tag=0 selects all topics.",
  "inputs": { "limit": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://app.cj.sina.com.cn/api/news/pc?page=1&size={{limit|url}}&tag=0" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "yahoo-finance-quote",
  "match": ["finance.yahoo.com"],
  "description": "Read a stock, ETF, or index quote through Yahoo's public v8 chart JSON API without signing in. Returns price, change, daily high and low, volume, 52-week range, currency, and exchange. Navigate directly to the JSON endpoint. Set symbol to a ticker such as AAPL, MSFT, ^GSPC, or BTC-USD.",
  "inputs": { "symbol": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://query1.finance.yahoo.com/v8/finance/chart/{{symbol}}?interval=1d&range=1d" },
    { "action": "wait", "loadState": "load" },
    { "action": "evaluate", "as": "quote", "fn": "() => { const raw = document.body.innerText || ''; let d; try { d = JSON.parse(raw); } catch(e) { throw new Error('Yahoo returned non-JSON quote content, possibly due to an access challenge or an API change. Retry later or use query2.finance.yahoo.com.'); } const c = d && d.chart && d.chart.result && d.chart.result[0]; if (!c) { const err = d && d.chart && d.chart.error; throw new Error('Quote unavailable' + (err ? (': ' + (err.description || err.code)) : ' (the symbol may be invalid)')); } const m = c.meta || {}; const prev = m.previousClose != null ? m.previousClose : m.chartPreviousClose; const price = m.regularMarketPrice; const change = (price != null && prev != null) ? (price - prev) : null; const pct = (change != null && prev) ? ((change / prev) * 100) : null; return { symbol: m.symbol, name: m.shortName || m.longName || m.symbol, price: price, change: change != null ? Number(change.toFixed(2)) : null, changePercent: pct != null ? Number(pct.toFixed(2)) : null, previousClose: prev, dayHigh: m.regularMarketDayHigh, dayLow: m.regularMarketDayLow, volume: m.regularMarketVolume, fiftyTwoWeekHigh: m.fiftyTwoWeekHigh, fiftyTwoWeekLow: m.fiftyTwoWeekLow, currency: m.currency, exchange: m.fullExchangeName || m.exchangeName }; }" }
  ],
  "output": "{{quote}}"
},{
  "id": "hf-model-search",
  "match": ["huggingface.co"],
  "description": "Search models through Hugging Face's public API and return a JSON array with model IDs, downloads, and likes.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://huggingface.co/api/models?search={{query|url}}&limit=20" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "imdb-search",
  "match": ["imdb.com"],
  "description": "Search IMDb movies, series, or people by keyword. Returns title, year, type, IMDb ID, and detail URL. No sign-in is required. Open the search page and parse its Next.js data because direct API requests may be blocked. Set query to a title or person's name.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.imdb.com/find/?q={{query|url}}&ref_=nv_sr_sm&language=en-US" },
    { "action": "wait", "loadState": "load" },
    { "action": "evaluate", "as": "results", "fn": "async () => { const deadline = Date.now() + 12000; const read = () => { const el = document.getElementById('__NEXT_DATA__'); if (!el) return null; let nd; try { nd = JSON.parse(el.textContent || 'null'); } catch(e) { return null; } const pp = nd && nd.props && nd.props.pageProps; if (!pp) return null; const out = []; const titles = (pp.titleResults && pp.titleResults.results) || []; for (const tr of titles) { const it = tr.listItem || {}; const tt = (it.titleText && (it.titleText.text || it.titleText)) || (it.originalTitleText && (it.originalTitleText.text || it.originalTitleText)) || ''; let yr = ''; if (it.releaseYear != null) yr = String(typeof it.releaseYear === 'object' ? (it.releaseYear.year || '') : it.releaseYear); const ty = (it.titleType && (it.titleType.text || it.titleType.id)) || it.titleType || 'title'; out.push({ id: tr.index || '', kind: 'title', title: tt, year: yr, type: ty, url: tr.index ? ('https://www.imdb.com/title/' + tr.index + '/') : '' }); } const names = (pp.nameResults && pp.nameResults.results) || []; for (const nr of names) { const it = nr.listItem || {}; const nm = (it.nameText && (it.nameText.text || it.nameText)) || ''; out.push({ id: nr.index || '', kind: 'name', title: nm, year: '', type: 'Person', url: nr.index ? ('https://www.imdb.com/name/' + nr.index + '/') : '' }); } return out; }; let r = read(); while ((!r || r.length === 0) && Date.now() < deadline) { await new Promise(res => setTimeout(res, 250)); r = read(); } if (r == null) throw new Error('Could not parse IMDb results; the page may have changed or access may be blocked. Retry the request.'); return r.slice(0, 25); }" }
  ],
  "output": "{{results}}"
},{
  "id": "instagram-profile",
  "match": ["instagram.com"],
  "description": "Read an Instagram account's public profile: username, display name, followers, following, post count, verification, and bio. Sign in to Instagram in the persistent browser first; the recipe opens instagram.com and fetches web_profile_info within the page using session cookies.",
  "inputs": { "username": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.instagram.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "profile",
      "fn": "async () => { const r = await fetch('https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent('{{username|js}}'), { credentials: 'include', headers: { 'X-IG-App-ID': '936619743392459' } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Instagram returned non-JSON content, possibly due to missing authentication or an access challenge. Sign in to Instagram in the persistent browser and retry.'); } const u = d && d.data && d.data.user; if (!u) throw new Error('User not found: {{username|js}}'); return { username: u.username, name: u.full_name || '', followers: (u.edge_followed_by && u.edge_followed_by.count) || 0, following: (u.edge_follow && u.edge_follow.count) || 0, posts: (u.edge_owner_to_timeline_media && u.edge_owner_to_timeline_media.count) || 0, verified: !!u.is_verified, private: !!u.is_private, bio: (u.biography || '').replace(/\\n/g, ' ').slice(0, 200), userId: u.id, url: 'https://www.instagram.com/' + u.username }; }"
    }
  ],
  "output": "{{profile}}"
},{
  "id": "jd-item",
  "match": ["jd.com"],
  "description": "Read a JD product's title, price, store, specifications, and main image. Sign in to JD in the persistent browser first. The recipe opens the product page and scrolls to load lazy content before extracting DOM fields. Set sku to the numeric ID in item.jd.com/<sku>.html.",
  "inputs": { "sku": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://item.jd.com/{{sku}}.html" },
    { "action": "wait", "loadState": "load" },
    { "action": "evaluate", "as": "scroll", "fn": "async () => { for (let i = 1; i <= 6; i++) { window.scrollTo(0, i * 2500); await new Promise(r => setTimeout(r, 700)); } window.scrollTo(0, document.body.scrollHeight); await new Promise(r => setTimeout(r, 1200)); return true; }" },
    { "action": "evaluate", "as": "item", "fn": `() => { const m = location.pathname.match(/(\\d+)\\.html/); const sku = m ? m[1] : ''; const txt = el => (el && el.textContent ? el.textContent.trim() : ''); const priceEl = document.querySelector('.J-p-' + sku) || document.querySelector('.p-price strong') || document.querySelector('[class*="price"] [class*="num"]'); const price = txt(priceEl) || 'Price unavailable (sign-in or lazy loading may be required)'; const title = txt(document.querySelector('.sku-name')) || txt(document.querySelector('.product-title')) || (document.title.split('-')[0] || '').trim(); const shop = txt(document.querySelector('.J-shop-name')) || txt(document.querySelector('[class*="shop"] a')) || 'JD-operated'; const imgs = Array.from(document.querySelectorAll('img[src*="360buyimg.com"]')).map(im => im.src).filter(Boolean); const images = [...new Set(imgs)].slice(0, 10); const specs = {}; const text = document.body.innerText || ''; const sm = text.match(${JD_SPECIFICATIONS_SECTION}); if (sm) { const lines = sm[0].split('\\n').map(l => l.trim()).filter(Boolean); for (let i = 0; i < lines.length - 1; i += 2) { const k = lines[i]; const v = lines[i + 1]; if (k && v && k !== ${JSON.stringify(JD_PRODUCT_CODE_LABEL)}) specs[k] = v; } } return { sku, title, price, shop, specs, images, totalImages: [...new Set(imgs)].length }; }` }
  ],
  "output": "{{item}}"
},{
  "id": "linkedin-jobs-search",
  "match": ["linkedin.com"],
  "description": "Search LinkedIn jobs and return titles and links through the internal Voyager API. Requires a signed-in session and an in-page request with csrf-token taken from the JSESSIONID cookie. LinkedIn may restrict accounts for automated activity.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.linkedin.com/feed/" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "jobs",
      "fn": "async () => { const js=document.cookie.split(';').map(p=>p.trim()).find(p=>p.indexOf('JSESSIONID=')===0); if(!js) throw new Error('JSESSIONID is unavailable. Sign in to LinkedIn in the persistent browser first.'); const csrf=js.slice('JSESSIONID='.length).replace(/^\"|\"$/g,''); const q=encodeURIComponent('{{query|js}}'); const query='(origin:JOB_SEARCH_PAGE_OTHER_ENTRY,keywords:'+q+',spellCorrectionEnabled:true)'; const url='/voyager/api/voyagerJobsDashJobCards?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220&count=25&q=jobSearch&query='+query+'&start=0'; const res=await fetch(url,{credentials:'include',headers:{'csrf-token':csrf,'x-restli-protocol-version':'2.0.0'}}); const t=await res.text(); let d; try{ d=JSON.parse(t); }catch(e){ throw new Error('LinkedIn returned non-JSON content, possibly due to missing authentication or an access challenge. Sign in through the persistent browser and retry.'); } const els=Array.isArray(d&&d.elements)?d.elements:[]; return els.map(el=>{ const card=el&&el.jobCardUnion&&el.jobCardUnion.jobPostingCard; if(!card) return null; const urn=String(card.jobPostingUrn||(card.jobPosting&&card.jobPosting.entityUrn)||card.entityUrn||''); const m=urn.match(/(\\d+)/); const id=m?m[1]:''; return { title: card.jobPostingTitle||(card.title&&card.title.text)||'', url: id?'https://www.linkedin.com/jobs/view/'+id:'' }; }).filter(Boolean); }"
    }
  ],
  "output": "{{jobs}}"
},{
  "id": "linuxdo-latest",
  "match": ["linux.do"],
  "description": "Read the latest linux.do Discourse topics with titles, reply counts, likes, views, and links. Open linux.do, then fetch /latest.json within the page. Public topics are readable without signing in; the browser session supplies any login and challenge cookies.",
  "inputs": {},
  "steps": [
    { "action": "navigate", "url": "https://linux.do" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "topics",
      "fn": "async () => { const r = await fetch('/latest.json', { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('linux.do returned non-JSON content, possibly due to a Cloudflare challenge or missing authentication. Open or sign in to the site in the persistent browser and retry.'); } const list = (d && d.topic_list && d.topic_list.topics) ? d.topic_list.topics : []; return list.map(x => ({ title: x.fancy_title || x.title, replies: Math.max(0, (x.posts_count || 1) - 1), likes: x.like_count || 0, views: x.views || 0, created: x.created_at, url: 'https://linux.do/t/topic/' + x.id })); }"
    }
  ],
  "output": "{{topics}}"
},{
  "id": "lobsters-feed",
  "match": ["lobste.rs"],
  "description": "Read a lobste.rs story feed as JSON. Set feed to hottest, newest, or active. Use the listing endpoints; search.json is unavailable.",
  "inputs": { "feed": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://lobste.rs/{{feed}}.json" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "jike-user-posts",
  "match": ["m.okjike.com", "okjike.com"],
  "description": "Read a Jike user's posts with text, type, likes, comments, timestamps, and links. The mobile site m.okjike.com embeds Next.js server-rendered data in an application/json script. Open the public profile and parse that data without signing in or calling another API.",
  "inputs": { "username": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://m.okjike.com/users/{{username}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "posts",
      "fn": "async () => { const el = document.getElementById('__NEXT_DATA__') || document.querySelector('script#__NEXT_DATA__[type=\"application/json\"]') || document.querySelector('script[type=\"application/json\"]'); if (!el) throw new Error('Jike server-rendered data is unavailable. The page may have changed, the user may not exist, or authentication may be required. Check the username or sign in through the persistent browser and retry.'); let data; try { data = JSON.parse(el.textContent); } catch (e) { throw new Error('Could not parse Jike server-rendered JSON.'); } const posts = (data && data.props && data.props.pageProps && data.props.pageProps.posts) ? data.props.pageProps.posts : []; return posts.map(p => ({ content: (p.content || '').replace(/\\n/g, ' ').slice(0, 200), type: p.type === 'ORIGINAL_POST' ? 'post' : p.type === 'REPOST' ? 'repost' : (p.type || ''), likes: p.likeCount || 0, comments: p.commentCount || 0, time: p.actionTime || p.createdAt || '', url: p.id ? 'https://web.okjike.com/originalPost/' + p.id : '' })); }"
    }
  ],
  "output": "{{posts}}"
},{
  "id": "medium-tag-feed",
  "match": ["medium.com"],
  "description": "Read recent Medium articles for a topic tag with title, author, link, publication time, and summary. Fetch the public RSS feed within the page and parse it with DOMParser. No sign-in is required. Set tag to a slug such as technology, programming, or artificial-intelligence.",
  "inputs": { "tag": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://medium.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "articles",
      "fn": "async () => { const r = await fetch('https://medium.com/feed/tag/' + encodeURIComponent('{{tag|js}}')); const t = await r.text(); if (!t || t.indexOf('<rss') === -1 && t.indexOf('<item') === -1) throw new Error('Medium RSS is unavailable; the tag may not exist or access may be blocked. Check the tag slug and retry.'); const doc = new DOMParser().parseFromString(t, 'text/xml'); const items = Array.from(doc.querySelectorAll('item')); const txt = (el, sel) => { const n = el.querySelector(sel); return n ? (n.textContent || '').trim() : ''; }; const strip = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim(); return items.map((it, i) => ({ rank: i + 1, title: txt(it, 'title'), author: (it.getElementsByTagName('dc:creator')[0] || {}).textContent || '', link: (txt(it, 'link') || txt(it, 'guid')).split('?')[0], published: txt(it, 'pubDate'), summary: strip(txt(it, 'description')).slice(0, 200) })); }"
    }
  ],
  "output": "{{articles}}"
},{
  "id": "wechat-article",
  "match": ["mp.weixin.qq.com"],
  "description": "Read a WeChat public-account article's title, account, author, publication time, full body, and image URLs without signing in. Pass its https://mp.weixin.qq.com/s/... or /s?__biz=... share link as url. The user must supply the article link; no anonymous search or listing endpoint is provided.",
  "inputs": { "url": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "{{url}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "article",
      "fn": "() => { if (location.hostname !== 'mp.weixin.qq.com') { throw new Error('The current page is not a WeChat public-account article (host: ' + location.hostname + '). url must be an https://mp.weixin.qq.com/s/... link.'); } const q = (s) => { const el = document.querySelector(s); return el ? el.textContent.trim() : ''; }; const content = document.querySelector('#js_content'); if (!content) { throw new Error('The page has no #js_content article container. The link may have expired, the article may have been removed or blocked, or a verification page may be displayed. Page begins: ' + (document.body.innerText || '').slice(0, 120)); } const images = Array.from(content.querySelectorAll('img')).map(im => im.getAttribute('data-src') || im.getAttribute('src') || '').filter(u => u.indexOf('http') === 0); const full = content.innerText.trim(); const MAX = 40000; return { title: q('#activity-name') || document.title, account: q('#js_name'), author: q('#js_author_name'), publishTime: q('#publish_time'), text: full.slice(0, MAX), truncated: full.length > MAX, images }; }"
    }
  ],
  "output": "{{article}}"
},{
  "id": "hn-search",
  "match": ["news.ycombinator.com", "hn.algolia.com"],
  "description": "Search Hacker News stories through its public Algolia API and return JSON with titles, links, authors, and scores.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://hn.algolia.com/api/v1/search?tags=story&query={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "npm-search",
  "match": ["npmjs.com", "registry.npmjs.org"],
  "description": "Search packages through the public npm registry API and return JSON with package names, versions, and descriptions.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://registry.npmjs.org/-/v1/search?text={{query|url}}&size=20" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "pixiv-search",
  "match": ["pixiv.net", "www.pixiv.net"],
  "description": "Search Pixiv illustrations by keyword or tag. Returns titles, creators, work IDs, page counts, bookmarks, tags, and links. Open pixiv.net, then call its Ajax search API within the signed-in page. Missing authentication produces an explicit error.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.pixiv.net" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "illusts",
      "fn": "async () => { const w = encodeURIComponent('{{query|js}}'); const r = await fetch('/ajax/search/illustrations/' + w + '?word=' + w + '&order=date_d&mode=all&p=1&s_mode=s_tag_full&type=illust_and_ugoira', { credentials: 'include' }); if (r.status === 401 || r.status === 403) throw new Error('Pixiv requires authentication. Sign in to pixiv.net in the persistent browser and retry.'); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Pixiv returned non-JSON content, possibly due to missing authentication or an access challenge. Sign in to pixiv.net in the persistent browser and retry.'); } const arr = (d && d.body && d.body.illust && Array.isArray(d.body.illust.data)) ? d.body.illust.data : []; return arr.filter(x => x.id).map(x => ({ title: x.title || '', author: x.userName || '', illust_id: x.id, pages: x.pageCount || 1, bookmarks: x.bookmarkCount || 0, tags: (x.tags || []).slice(0, 5).join(', '), url: 'https://www.pixiv.net/artworks/' + x.id })); }"
    }
  ],
  "output": "{{illusts}}"
},{
  "id": "producthunt-feed",
  "match": ["producthunt.com", "www.producthunt.com"],
  "description": "Read new Product Hunt launches from its public Atom feed without signing in. Output is Atom XML: each <entry> contains the product title, tagline in content, author/name, published time, and link href.",
  "steps": [
    { "action": "navigate", "url": "https://www.producthunt.com/feed" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "xml", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{xml}}"
},{
  "id": "pubmed-search",
  "match": ["pubmed.ncbi.nlm.nih.gov", "eutils.ncbi.nlm.nih.gov"],
  "description": "Search PubMed literature by keyword through NCBI E-utilities esearch and return matching PMID IDs as JSON.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "pypi-package",
  "match": ["pypi.org"],
  "description": "Read a PyPI package's public metadata API and return JSON with name, version, summary, and releases.",
  "inputs": { "package": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://pypi.org/pypi/{{package}}/json" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "reddit-listing",
  "match": ["reddit.com"],
  "description": "Read a subreddit's hot posts with titles, subreddit, score, comment count, author, and link. Open reddit.com first, then fetch JSON within the page using session cookies; direct .json navigation may return SPA HTML or an access challenge.",
  "inputs": { "subreddit": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.reddit.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "posts",
      "fn": "async () => { const r = await fetch('/r/{{subreddit|js}}/hot.json?limit=25&raw_json=1', { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Reddit returned non-JSON content, possibly due to blocked access or missing authentication. Open or sign in to the site in the persistent browser and retry.'); } return (d && d.data && d.data.children ? d.data.children : []).map(c => ({ title: c.data.title, subreddit: c.data.subreddit_name_prefixed, score: c.data.score, comments: c.data.num_comments, author: c.data.author, url: 'https://www.reddit.com' + c.data.permalink })); }"
    }
  ],
  "output": "{{posts}}"
},{
  "id": "reuters-search",
  "match": ["reuters.com", "www.reuters.com"],
  "description": "Search Reuters news by keyword and return titles, dates, sections, and links. Open reuters.com, then call its search JSON endpoint within the page with browser cookies and required headers. Missing authentication or blocked access produces an explicit error.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.reuters.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "articles",
      "fn": "async () => { const q = JSON.stringify({ keyword: '{{query|js}}', offset: 0, orderby: 'display_date:desc', size: 20, website: 'reuters' }); const r = await fetch('/pf/api/v3/content/fetch/articles-by-search-v2?query=' + encodeURIComponent(q), { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Reuters returned non-JSON content, possibly due to blocked access or a regional restriction. Open reuters.com in the persistent browser and retry.'); } const arr = (d && d.result && Array.isArray(d.result.articles)) ? d.result.articles : []; return arr.map(a => ({ title: a.title || (a.headlines && a.headlines.basic) || '', date: (a.display_date || a.published_time || '').split('T')[0], section: (a.taxonomy && a.taxonomy.section && a.taxonomy.section.name) || '', url: a.canonical_url ? 'https://www.reuters.com' + a.canonical_url : '' })); }"
    }
  ],
  "output": "{{articles}}"
},{
  "id": "hockey-search",
  "match": ["scrapethissite.com"],
  "description": "Search teams on the scrapethissite forms page and extract results. This sample recipe demonstrates typing and submitting with Enter.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.scrapethissite.com/pages/forms/" },
    { "action": "type", "selector": "input[name=q]", "value": "{{query}}", "submit": true },
    { "action": "wait", "loadState": "load" },
    {
      "action": "extract",
      "as": "teams",
      "extract": {
        "from": "tr.team",
        "multiple": true,
        "fields": {
          "name": ".name",
          "wins": ".wins",
          "losses": ".losses"
        }
      }
    }
  ],
  "output": "{{teams}}"
},{
  "id": "smzdm-search",
  "match": ["smzdm.com", "search.smzdm.com"],
  "description": "Search SMZDM deals and products with titles, prices, merchants, comment counts, and links. Open the search page and extract rendered DOM content. A signed-in persistent browser can provide fuller results and fewer access challenges.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://search.smzdm.com/?c=home&s={{query|url}}&v=b" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "extract",
      "as": "items",
      "extract": {
        "from": "li.feed-row-wide",
        "multiple": true,
        "limit": 20,
        "fields": {
          "title": { "selector": "h5.feed-block-title a", "attr": "title" },
          "price": ".z-highlight",
          "mall": ".z-feed-foot-r .feed-block-extras span",
          "url": { "selector": "h5.feed-block-title a", "type": "href" }
        }
      }
    }
  ],
  "output": "{{items}}"
},{
  "id": "stackoverflow-search",
  "match": ["stackoverflow.com", "api.stackexchange.com"],
  "description": "Search Stack Overflow questions by relevance through the public Stack Exchange API and return JSON with titles, links, and scores.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q={{query|url}}&site=stackoverflow" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "steam-search",
  "match": ["store.steampowered.com"],
  "description": "Search Steam games and apps by keyword through the public storesearch API without signing in. Returns name, AppID, price, platforms, Metacritic score, and detail URL. Prices use integer minor currency units; for example, 999 represents $9.99 in USD.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://store.steampowered.com/" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": "async () => { const r = await fetch('/api/storesearch/?cc=us&l=english&term=' + encodeURIComponent('{{query|js}}'), { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Steam returned non-JSON content, possibly due to an access challenge. Retry later or open store.steampowered.com in the persistent browser.'); } return (d && d.items ? d.items : []).map(g => ({ appid: g.id, name: g.name, type: g.type, price: g.price ? g.price.final : null, currency: g.price ? g.price.currency : '', metascore: g.metascore || '', platforms: g.platforms ? Object.keys(g.platforms).filter(k => g.platforms[k]).join(',') : '', url: g.id ? 'https://store.steampowered.com/app/' + g.id : '' })); }"
    }
  ],
  "output": "{{items}}"
},{
  "id": "substack-search",
  "match": ["substack.com"],
  "description": "Search Substack articles by keyword with titles, authors, dates, summaries, and links. Open substack.com, then fetch its search JSON endpoint within the page with the required headers. No sign-in is required; direct API navigation may return SPA HTML.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://substack.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "posts",
      "fn": "async () => { const r = await fetch('/api/v1/post/search?query=' + encodeURIComponent('{{query|js}}') + '&page=0&includePlatformResults=true', { credentials: 'include', headers: { Accept: 'application/json' } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Substack returned non-JSON content, possibly due to an access challenge or an API change. Open substack.com in the persistent browser and retry.'); } return (d && Array.isArray(d.results) ? d.results : []).map(x => ({ title: x.title, author: (x.publishedBylines && x.publishedBylines[0] && x.publishedBylines[0].name) || '', date: (x.post_date || '').split('T')[0], description: (x.description || x.subtitle || x.truncated_body_text || '').slice(0, 200), url: x.canonical_url })); }"
    }
  ],
  "output": "{{posts}}"
},{
  "id": "tieba-hot-topics",
  "match": ["tieba.baidu.com"],
  "description": "Read Baidu Tieba trending topics with titles, discussion counts, summaries, and links. Open the server-rendered page and extract li.topic-top-item elements without signing in or calling an API.",
  "inputs": {},
  "steps": [
    { "action": "navigate", "url": "https://tieba.baidu.com/hottopic/browse/topicList?res_type=1" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "extract",
      "as": "topics",
      "extract": {
        "from": "li.topic-top-item",
        "multiple": true,
        "limit": 30,
        "fields": {
          "title": "a.topic-text",
          "discussions": "span.topic-num",
          "description": "p.topic-top-item-desc",
          "url": { "selector": "a.topic-text", "type": "href" }
        }
      }
    }
  ],
  "output": "{{topics}}"
},{
  "id": "v2ex-hot",
  "match": ["v2ex.com"],
  "description": "Read current V2EX hot topics with titles, nodes, reply counts, and links. Navigate directly to the public JSON endpoint; no sign-in is required.",
  "inputs": {},
  "steps": [
    { "action": "navigate", "url": "https://www.v2ex.com/api/topics/hot.json" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "weibo-hot",
  "match": ["weibo.com"],
  "description": "Read Weibo search trends with rank, term, popularity, category, label, and link. Open weibo.com, then fetch JSON within the page using session cookies. Direct Ajax endpoint navigation may return SPA HTML or an access challenge.",
  "inputs": { "limit": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://weibo.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": "async () => { const limit = Number('{{limit|js}}') || 30; const r = await fetch('/ajax/statuses/hot_band', { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Weibo returned non-JSON content, possibly due to missing authentication or an access challenge. Sign in to weibo.com in the persistent browser and retry.'); } if (!d || !d.ok) throw new Error('The Weibo trending API returned an error, possibly due to missing authentication. Sign in to weibo.com in the persistent browser and retry.'); const list = (d.data && d.data.band_list) ? d.data.band_list : []; return list.slice(0, limit).map((b, i) => ({ rank: b.realpos || (i + 1), word: b.word, hot: b.num || 0, category: b.category || '', label: b.label_name || '', url: 'https://s.weibo.com/weibo?q=' + encodeURIComponent('#' + b.word + '#') })); }"
    }
  ],
  "output": "{{items}}"
},{
  "id": "weread-search",
  "match": ["weread.qq.com"],
  "description": "Search WeRead books by keyword through the public /web/search/global endpoint without signing in. Returns book titles, authors, and IDs. Read the books array; each bookInfo.bookId can identify a detail request.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://weread.qq.com/web/search/global?keyword={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "wikipedia-search",
  "match": ["wikipedia.org"],
  "description": "Search Wikipedia entries through the public MediaWiki API and return JSON with titles and summary snippets.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={{query|url}}&srlimit=20&format=json&utf8=1" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "json", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{json}}"
},{
  "id": "coupang-search",
  "match": ["coupang.com"],
  "description": "Search Coupang products with rank, title, product ID, price, original price, rating, review count, and detail link. Open coupang.com, then fetch search JSON within the page using session cookies. Missing authentication or blocked access can return HTML instead of JSON.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.coupang.com/np/search?channel=user&page=1&q={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": "async () => { const num = v => { const s = (v == null ? '' : String(v)).replace(/[^\\d.]/g, ''); const n = Number(s); return s && Number.isFinite(n) ? n : null; }; const r = await fetch('/np/search?q=' + encodeURIComponent('{{query|js}}') + '&channel=user&page=1', { credentials: 'include' }); const t = await r.text(); if (t.trim().startsWith('<')) throw new Error('Coupang returned HTML instead of JSON, possibly due to missing authentication or blocked access. Sign in to coupang.com in the persistent browser and retry.'); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Coupang returned non-JSON content, possibly due to blocked access. Sign in to coupang.com in the persistent browser and retry.'); } const list = d.data && (d.data.products || d.data.productList) || d.products || d.productList || d.items || []; return (Array.isArray(list) ? list : []).slice(0, 20).map((p, i) => { const pid = String(p.productId || p.product_id || p.id || p.productNo || '').match(/(\\d{6,})/); const id = pid ? pid[1] : ''; return { rank: i + 1, title: p.title || p.name || p.productName || '', productId: id, price: num(p.price || p.salePrice || p.finalPrice || p.sellingPrice), originalPrice: num(p.originalPrice || p.basePrice || p.listPrice), rating: num(p.rating || p.star || p.reviewRating), reviewCount: num(p.reviewCount || p.ratingCount || p.reviews), url: id ? 'https://www.coupang.com/vp/products/' + id : '' }; }); }"
    }
  ],
  "output": "{{items}}"
},{
  "id": "xiaoyuzhou-podcast",
  "match": ["xiaoyuzhoufm.com"],
  "description": "Read a Xiaoyuzhou podcast's name, creator, description, subscriber count, episode count, and embedded recent episodes with IDs, titles, durations, plays, and dates. Set podcast_id to the final segment of xiaoyuzhoufm.com/podcast/<ID>. Parse the page's __NEXT_DATA__; no sign-in is required.",
  "inputs": { "podcast_id": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.xiaoyuzhoufm.com/podcast/{{podcast_id}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "podcast",
      "fn": "() => { const fmtDur = s => { if (!Number.isFinite(s) || s < 0) return '-'; s = Math.round(s); return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0'); }; const nd = window.__NEXT_DATA__; const pp = nd && nd.props && nd.props.pageProps ? nd.props.pageProps : null; const p = pp && pp.podcast; if (!p) throw new Error('Xiaoyuzhou podcast data is unavailable; the ID may not exist or the page may have changed. Check the ID in xiaoyuzhoufm.com/podcast/<ID>.'); const eps = Array.isArray(p.episodes) ? p.episodes : []; return { title: p.title, author: p.author, description: p.brief, subscribers: p.subscriptionCount, episodeCount: p.episodeCount, latest: (p.latestEpisodePubDate || '').slice(0,10), episodes: eps.slice(0,15).map(e => ({ eid: e.eid, title: e.title, duration: fmtDur(e.duration), plays: e.playCount, date: (e.pubDate || '').slice(0,10) })) }; }"
    }
  ],
  "output": "{{podcast}}"
},{
  "id": "zsxq-dynamics",
  "match": ["wx.zsxq.com", "zsxq.com"],
  "description": "Read recent activity from all Zsxq groups joined by the signed-in account, including time, group, author, title, comments, likes, and link. Open wx.zsxq.com, then fetch api.zsxq.com within the page with credentials; its authentication cookies are httpOnly.",
  "inputs": {},
  "steps": [
    { "action": "navigate", "url": "https://wx.zsxq.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "dynamics",
      "fn": "async () => { const r = await fetch('https://api.zsxq.com/v2/dynamics?scope=general&count=20', { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Zsxq returned non-JSON content, possibly due to missing authentication or an access challenge. Sign in to Zsxq in the persistent browser and retry.'); } if (d && d.succeeded === false) { throw new Error('Zsxq API error (authentication may be required): ' + (d.info || d.code)); } const rd = (d && d.resp_data) ? d.resp_data : d; const list = (rd && rd.dynamics) ? rd.dynamics : []; const textOf = (tp) => { if (!tp) return ''; const p = [tp.title, tp.talk && tp.talk.text, tp.question && tp.question.text, tp.answer && tp.answer.text, tp.task && tp.task.text, tp.solution && tp.solution.text].find(v => typeof v === 'string' && v.trim()); return (p || '').replace(/\\s+/g, ' ').trim(); }; const authorOf = (tp) => (tp && (tp.owner && tp.owner.name || tp.talk && tp.talk.owner && tp.talk.owner.name || tp.question && tp.question.owner && tp.question.owner.name || tp.answer && tp.answer.owner && tp.answer.owner.name)) || ''; return list.map(x => { const tp = x.topic; return { time: x.create_time || (tp && tp.create_time) || '', group: (tp && tp.group && tp.group.name) || '', author: authorOf(tp), title: textOf(tp).slice(0, 120), comments: (tp && tp.comments_count) || 0, likes: (tp && tp.likes_count) || 0, url: (tp && tp.topic_id) ? 'https://wx.zsxq.com/topic/' + tp.topic_id : '' }; }); }"
    }
  ],
  "output": "{{dynamics}}"
},{
  "id": "twitter-profile",
  "match": ["x.com", "twitter.com"],
  "description": "Read an X (Twitter) account's name, bio, location, followers, following, post count, verification, and join date. Sign in to x.com in the persistent browser first. The recipe opens x.com, reads the CSRF cookie, and calls the internal UserByScreenName GraphQL endpoint within the page. Omit @ from username.",
  "inputs": { "username": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://x.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "profile",
      "fn": "async () => { const ct0 = (document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('ct0=')) || '').split('=')[1]; if (!ct0) throw new Error('x.com authentication is missing (no ct0 cookie). Sign in to X in the persistent browser and retry.'); const bearer = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'; const headers = { 'Authorization': 'Bearer ' + decodeURIComponent(bearer), 'X-Csrf-Token': ct0, 'X-Twitter-Auth-Type': 'OAuth2Session', 'X-Twitter-Active-User': 'yes' }; const variables = JSON.stringify({ screen_name: '{{username|js}}'.replace(/^@/, ''), withSafetyModeUserFields: true }); const features = JSON.stringify({ hidden_profile_subscriptions_enabled: true, rweb_tipjar_consumption_enabled: true, responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false, subscriptions_verification_info_is_identity_verified_enabled: true, subscriptions_verification_info_verified_since_enabled: true, highlights_tweets_tab_ui_enabled: true, responsive_web_twitter_article_notes_tab_enabled: true, subscriptions_feature_can_gift_premium: true, creator_subscriptions_tweet_preview_api_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true }); const url = '/i/api/graphql/qRednkZG-rn1P6b48NINmQ/UserByScreenName?variables=' + encodeURIComponent(variables) + '&features=' + encodeURIComponent(features); const r = await fetch(url, { headers: headers, credentials: 'include' }); const txt = await r.text(); let d; try { d = JSON.parse(txt); } catch (e) { throw new Error('x.com returned non-JSON content, possibly due to missing authentication, an access challenge, or an internal API change. Sign in through the persistent browser and retry.'); } const res = d && d.data && d.data.user && d.data.user.result; if (!res) throw new Error('User not found: @' + '{{username|js}}'.replace(/^@/, '')); const lg = res.legacy || {}; const expanded = lg.entities && lg.entities.url && lg.entities.url.urls && lg.entities.url.urls[0] && lg.entities.url.urls[0].expanded_url; return { screen_name: lg.screen_name || '{{username|js}}'.replace(/^@/, ''), name: lg.name || '', bio: lg.description || '', location: lg.location || '', link: expanded || '', followers: lg.followers_count || 0, following: lg.friends_count || 0, tweets: lg.statuses_count || 0, likes: lg.favourites_count || 0, verified: !!(res.is_blue_verified || lg.verified), created_at: lg.created_at || '', url: 'https://x.com/' + (lg.screen_name || '{{username|js}}'.replace(/^@/, '')) }; }"
    }
  ],
  "output": "{{profile}}"
},{
  "id": "xiaohongshu-search",
  "match": ["xiaohongshu.com"],
  "description": "Search Xiaohongshu notes with titles, creators, likes, and links. Requires a signed-in session. Open the search page, scroll to load results, and extract section.note-item elements; direct internal API requests require an x-s signature.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.xiaohongshu.com/search_result?keyword={{query|url}}&source=web_search_result_notes" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": `async () => { const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const norm=v=>(v||'').replace(/\\s+/g,' ').trim(); const abs=h=>!h?'':(h.indexOf('http')===0?h:'https://www.xiaohongshu.com'+h); const body=document.body&&document.body.innerText||''; if(${XIAOHONGSHU_SIGN_IN_TEXT}.test(body) && !document.querySelector('section.note-item')) throw new Error('Xiaohongshu search requires authentication. Sign in through the persistent browser and retry.'); for(let i=0;i<3;i++){ window.scrollTo(0,document.body.scrollHeight); await sleep(1200); } const out=[]; const seen=new Set(); document.querySelectorAll('section.note-item').forEach(el=>{ if(el.classList.contains('query-note-item')) return; const t=el.querySelector('.title, .note-title, a.title, .footer .title span'); const n=el.querySelector('a.author .name, .name, .author-name, .nick-name, a.author'); const c=el.querySelector('.count, .like-count, .like-wrapper .count'); const linkEl=el.querySelector('a.cover.mask')||el.querySelector('a[href*="/search_result/"]')||el.querySelector('a[href*="/explore/"]')||el.querySelector('a[href*="/note/"]'); const url=abs(linkEl&&linkEl.getAttribute('href')||''); const title=norm(t&&t.textContent); if(!title||!url||seen.has(url)) return; seen.add(url); out.push({ rank: out.length+1, title: title, author: norm(n&&n.textContent), likes: norm(c&&c.textContent), url: url }); }); return out.slice(0,20); }`
    }
  ],
  "output": "{{items}}"
},{
  "id": "xueqiu-search-stock",
  "match": ["xueqiu.com"],
  "description": "Search Xueqiu stocks by code or name and return symbol, name, exchange, price, percentage change, and detail link. Open xueqiu.com, then fetch JSON within the page using session cookies. Direct API navigation may return SPA HTML or be blocked.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://xueqiu.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "stocks",
      "fn": "async () => { const r = await fetch('https://xueqiu.com/stock/search.json?size=10&code=' + encodeURIComponent('{{query|js}}'), { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Xueqiu returned non-JSON content, possibly due to missing authentication or an access challenge. Sign in to xueqiu.com in the persistent browser and retry.'); } return (d.stocks || []).map(s => { const ex = s.exchange; let symbol = (ex === 'SH' || ex === 'SZ' || ex === 'BJ') ? (String(s.code).startsWith(ex) ? s.code : ex + s.code) : s.code; return { symbol: symbol, name: s.name, exchange: ex, price: s.current, changePercent: s.percentage != null ? s.percentage.toFixed(2) + '%' : null, url: 'https://xueqiu.com/S/' + symbol }; }); }"
    }
  ],
  "output": "{{stocks}}"
},{
  "id": "youtube-search",
  "match": ["youtube.com", "www.youtube.com"],
  "description": "Search YouTube videos by keyword with titles, channels, views, duration, publication time, and links. Open the results page and parse window.ytInitialData. Usually no sign-in is required; the persistent browser session may yield personalized results.",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.youtube.com/results?search_query={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "videos",
      "fn": "async () => { const data = window.ytInitialData; if (!data) throw new Error('YouTube ytInitialData is unavailable; the page may still be loading or access may be blocked. Open youtube.com in the persistent browser and retry.'); const sections = (((((data.contents || {}).twoColumnSearchResultsRenderer || {}).primaryContents || {}).sectionListRenderer || {}).contents) || []; const out = []; for (const sec of sections) { const items = ((sec.itemSectionRenderer || {}).contents) || []; for (const it of items) { const v = it.videoRenderer; if (!v) continue; out.push({ title: (v.title && v.title.runs && v.title.runs[0] && v.title.runs[0].text) || '', channel: (v.ownerText && v.ownerText.runs && v.ownerText.runs[0] && v.ownerText.runs[0].text) || '', views: (v.viewCountText && (v.viewCountText.simpleText || (v.shortViewCountText && v.shortViewCountText.simpleText))) || '', duration: (v.lengthText && v.lengthText.simpleText) || 'LIVE', published: (v.publishedTimeText && v.publishedTimeText.simpleText) || '', url: 'https://www.youtube.com/watch?v=' + v.videoId }); } } return out; }"
    }
  ],
  "output": "{{videos}}"
},{
  "id": "zhihu-search",
  "match": ["zhihu.com"],
  "description": "Search Zhihu questions, answers, and articles by keyword with title, type, author, votes, and link. Open zhihu.com, then fetch JSON within the page using session cookies. Direct API navigation may return SPA HTML or an access challenge.",
  "inputs": { "query": { "required": true }, "limit": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.zhihu.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": "async () => { const strip = (h) => (h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim(); const limit = Number('{{limit|js}}') || 10; const r = await fetch('https://www.zhihu.com/api/v4/search_v3?t=general&offset=0&limit=' + limit + '&q=' + encodeURIComponent('{{query|js}}'), { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Zhihu returned non-JSON content, possibly due to missing authentication or an access challenge. Sign in to zhihu.com in the persistent browser and retry.'); } return (d && d.data ? d.data : []).filter(it => it.type === 'search_result').map((it, i) => { const o = it.object || {}; const q = o.question || {}; const url = o.type === 'answer' ? 'https://www.zhihu.com/question/' + q.id + '/answer/' + o.id : o.type === 'article' ? 'https://zhuanlan.zhihu.com/p/' + o.id : 'https://www.zhihu.com/question/' + o.id; return { rank: i + 1, title: strip(o.title || q.name || ''), type: o.type, author: (o.author && o.author.name) || '', votes: o.voteup_count || 0, url }; }); }"
    }
  ],
  "output": "{{items}}"
}];

export const BUILTIN_BROWSER_SITE_GUIDES: readonly unknown[] = [{
  "site": "36kr.com",
  "auth": "Reading news does not require sign-in.",
  "entry": {
    "home": "https://www.36kr.com/",
    "rssFeed": "https://www.36kr.com/feed",
    "searchPage": "https://www.36kr.com/search/articles/<keyword>",
    "hotList": "https://www.36kr.com/hot-list/catalog",
    "articlePage": "https://www.36kr.com/p/<articleId>"
  },
  "recipes": ["36kr-news"],
  "notes": "Use the public RSS feed at www.36kr.com/feed for news. The 36kr-news recipe navigates there and reads the body as RSS XML. Parse each <item> for <title>, <link> (possibly CDATA), <pubDate>, and <description>; strip HTML from the summary. Other pages require SPA rendering and DOM extraction: search at www.36kr.com/search/articles/<keyword>, rankings at www.36kr.com/hot-list/catalog, and articles at www.36kr.com/p/<id>. Ranking types renqi (popular), zonghe (overall), and shoucang (saved) use /hot-list/<type>/<YYYY-MM-DD>/1. Wait for rendering before snapshot/extract; use .article-title/h1 for titles, [class*=article-content] p for article text, and a[href*='/p/'] for search or ranking links. These DOM paths are less stable than RSS. The recipe reads the RSS news feed."
},{
  "site": "api.fxtwitter.com",
  "auth": "No sign-in or API key is required. FxTwitter (FixTweet) exposes a public read-only API for public X posts and profiles.",
  "entry": {
    "tweet": "https://api.fxtwitter.com/status/<id>",
    "tweetWithUser": "https://api.fxtwitter.com/<screen_name>/status/<id>",
    "userProfile": "https://api.fxtwitter.com/<screen_name>"
  },
  "recipes": ["x-tweet"],
  "notes": "Navigate directly to the API URL and parse the body as JSON. The response is {code,message,tweet:{text,author:{screen_name,name,followers},replies,retweets,likes,quotes,bookmarks,views,created_at,lang,replying_to,media:{photos[],videos[]},quote}}; code 404 means missing, deleted, or private content. The x-tweet recipe wraps /status/<id> and flattens common fields. Public profiles are also available at /<screen_name>, returning {code,message,user:{screen_name,name,followers,following,tweets,likes,description,joined,...}}. Navigate and parse this endpoint directly; no recipe or x.com session is needed. This API provides individual posts and profiles. Timelines, search, and reply lists require the authenticated x.com GraphQL paths described in the x.com site guide."
},{
  "site": "arxiv.org",
  "auth": "Read-only access does not require sign-in.",
  "entry": {
    "searchApi": "https://export.arxiv.org/api/query?search_query=all:&max_results=20&sortBy=relevance"
  },
  "recipes": ["arxiv-search"],
  "notes": "Search the public arXiv API at https://export.arxiv.org/api/query?search_query=all:&max_results=20&sortBy=relevance. It returns Atom XML: each <entry> under <feed> contains <title>, <summary>, <author><name>, <id> (paper URL), and <published>. Navigate to the URL, extract the body XML, and parse entries. Use HTTPS to avoid an HTTP redirect. search_query supports prefixes such as all:, ti:, au:, and abs:; sortBy accepts relevance, lastUpdatedDate, or submittedDate."
},{
  "site": "barchart.com",
  "auth": "Sign in to barchart.com in the persistent browser. Its proxy API requires session cookies and the page CSRF token.",
  "entry": {
    "quotePage": "https://www.barchart.com/stocks/quotes/<symbol>/overview",
    "optionsPage": "https://www.barchart.com/stocks/quotes/<symbol>/options",
    "unusualActivityPage": "https://www.barchart.com/options/unusual-activity/stocks"
  },
  "recipes": ["barchart-quote"],
  "notes": "Requests to /proxies/core-api/v1/... require credentials:'include' and the value of <meta name=\"csrf-token\"> in the X-CSRF-TOKEN header. First navigate to the matching overview/options page, wait for Angular to insert the token if necessary, then fetch within that page. Direct API navigation or an unauthenticated session may return SPA HTML instead of JSON.\nQuotes: GET /proxies/core-api/v1/quotes/get?symbol=<SYM>&fields=symbol,symbolName,lastPrice,priceChange,percentChange,openPrice,highPrice,lowPrice,previousPrice,volume,averageVolume,marketCap,peRatio,earningsPerShare,tradeTime returns {data:[{...}]}. The barchart-quote recipe unwraps this into output.\nOptions: GET /proxies/core-api/v1/options/chain?symbol=<SYM>&fields=strikePrice,bidPrice,askPrice,lastPrice,priceChange,volume,openInterest,volatility,delta,gamma,theta,vega,rho,expirationDate,optionType,percentFromLast&raw=1[&expirationDate=YYYY-MM-DD] returns {data:[{...}]}. Filter optionType by call/put and sort by |percentFromLast| for near-the-money contracts.\nUnusual activity: GET /proxies/core-api/v1/options/get?list=options.unusual_activity.stocks.us&fields=baseSymbol,strikePrice,expirationDate,optionType,lastPrice,volume,openInterest,volumeOpenInterestRatio,volatility&orderBy=volumeOpenInterestRatio&orderDir=desc&raw=1&limit=20. This list may be empty after market close; list=options.mostActive.us is another available list.\nMost fields are formatted strings, such as percentChange='+0.56%'; use row.raw for raw numbers."
},{
  "site": "bbc.com",
  "auth": "Public RSS feeds do not require sign-in.",
  "entry": {
    "topNews": "https://feeds.bbci.co.uk/news/rss.xml",
    "world": "https://feeds.bbci.co.uk/news/world/rss.xml",
    "technology": "https://feeds.bbci.co.uk/news/technology/rss.xml",
    "business": "https://feeds.bbci.co.uk/news/business/rss.xml",
    "sport": "https://feeds.bbci.co.uk/sport/rss.xml"
  },
  "recipes": ["bbc-news-feed"],
  "notes": "Use the official RSS host feeds.bbci.co.uk. The bbc-news-feed recipe inserts section into https://feeds.bbci.co.uk/{section}/rss.xml: news for top stories; news/world, news/technology, news/business, news/health, or news/science_and_environment for sections; sport or sport/football for sports. Each RSS XML <item> contains <title>, <description>, <link>, <pubDate>, and <guid>. Navigate to <link> for the full article. There is no public search API; fetch a section and filter locally."
},{
  "site": "bilibili.com",
  "auth": "Public popular and ranking lists can be read without sign-in. A persistent browser signed in to bilibili.com may reduce access challenges and provide personalized results.",
  "entry": {
    "home": "https://www.bilibili.com",
    "popular": "https://api.bilibili.com/x/web-interface/popular?pn=1&ps=<limit>",
    "ranking": "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all"
  },
  "recipes": ["bilibili-hot"],
  "notes": "First navigate to https://www.bilibili.com, then evaluate fetch with the full API URL and {credentials:'include'} in the page. Direct navigation to api.bilibili.com can return SPA HTML or an access challenge. The bilibili-hot recipe uses /x/web-interface/popular?pn=1&ps=<limit>, returning {data:{list:[{title,owner:{name},stat:{view,danmaku},bvid}]}}. The unsigned ranking endpoint /x/web-interface/ranking/v2?rid=0&type=all returns the same data.list shape and supports the same in-page fetch pattern. Video URLs are https://www.bilibili.com/video/<bvid>. Search at /x/web-interface/wbi/search/type requires dynamic WBI signatures (w_rid and wts derived from the nav endpoint's img_key/sub_key); use page interaction for search. Use the persistent browser session for reliable JSON responses."
},{
  "site": "blog.sina.com.cn",
  "auth": "Read-only search does not require sign-in.",
  "entry": {
    "home": "https://blog.sina.com.cn/",
    "searchApi": "https://search.sina.com.cn/api/search?q=<keyword>&tp=mix",
    "userArticleList": "https://blog.sina.com.cn/s/articlelist_<uid>_0_1.html",
    "articlePage": "https://blog.sina.com.cn/s/blog_<id>.html"
  },
  "recipes": ["sinablog-search"],
  "notes": "Use the public Sina search JSON API at search.sina.com.cn/api/search?q=<keyword>&tp=mix&sort=0&page=1&size=20&from=search_result. The sinablog-search recipe navigates there and reads {data:{list:[{title,media_show/author,time/dataTime,intro/searchSummary,url}]}} from the body. Strip HTML from title and keep URLs containing 'blog.sina.com.cn/s/blog_' for blog posts. Other pages require less stable DOM extraction: home rankings use .day-hot-rank/.hot-rank with a[href*='/s/blog_']; user lists at blog.sina.com.cn/s/articlelist_<uid>_0_1.html use .articleList .articleCell; posts at blog.sina.com.cn/s/blog_<id>.html use .articalTitle h2 for the title and .articalContent/.blog_content for text. For full text, navigate to the post and extract .articalContent."
},{
  "site": "bloomberg.com",
  "auth": "Public RSS headlines do not require sign-in. Full articles require a valid subscription session and may present an access challenge.",
  "entry": {
    "rss": "https://feeds.bloomberg.com/<section>/news.rss",
    "rssMain": "https://feeds.bloomberg.com/news.rss"
  },
  "recipes": ["bloomberg-feed"],
  "notes": "The bloomberg-feed recipe reads public RSS headlines. Full articles on www.bloomberg.com require the user's subscription session; story.body in __NEXT_DATA__ is subject to the same access requirements.\nNavigate to the RSS URL and read document.body.innerText, then parse <item> elements. The recipe returns title, summary, link, and pubDate directly in output. Section paths are markets → /markets/news.rss, technology → /technology/news.rss, economics → /economics/news.rss, politics → /politics/news.rss, industries → /industries/news.rss, businessweek → /businessweek/news.rss, and opinions → /bview/news.rss. The combined feed is https://feeds.bloomberg.com/news.rss; navigate directly to rssMain. Do not pass section=news to the recipe: that constructs the nonexistent /news/news.rss. Items include title, description, link, guid, pubDate, and image URLs in media:content, media:thumbnail, or enclosure. Open article links in the user's authenticated browser for subscription content."
},{
  "site": "books.toscrape.com",
  "auth": "No sign-in is required.",
  "entry": { "home": "https://books.toscrape.com/" },
  "pages": [
    {
      "type": "listing",
      "urlPattern": "https://books.toscrape.com/catalogue/page-:n.html",
      "container": "article.product_pod"
    }
  ],
  "recipes": ["books-list"],
  "notes": "This is a static site. Book cards use article.product_pod; titles are in h3 a[title], prices in .price_color, and availability in .availability. Pagination uses catalogue/page-N.html."
},{
  "site": "bsky.app",
  "auth": "Public content can be read without sign-in through the AT Protocol host public.api.bsky.app.",
  "entry": {
    "authorFeed": "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=<handle>&limit=25",
    "profile": "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=<handle>",
    "searchActors": "https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=<query>&limit=10"
  },
  "recipes": ["bluesky-user-posts"],
  "notes": "The public.api.bsky.app app.bsky.* XRPC endpoints return JSON without cookies or tokens; navigate directly and extract the body. The bluesky-user-posts recipe wraps getAuthorFeed, returning {feed:[{post:{record:{text,createdAt},author:{handle,displayName},likeCount,repostCount,replyCount,uri}}],cursor}. Other read endpoints include actor.getProfile?actor=<handle>, returning {handle,displayName,followersCount,followsCount,postsCount,description}; actor.searchActors?q=<query>&limit=10, returning {actors:[{handle,displayName,description}]}; graph.getFollowers and graph.getFollows?actor=<handle>; and feed.getPostThread?uri=<at-uri>&depth=2. searchActors does not include followersCount; fetch getProfile for that field. Full-text feed.searchPosts requires authentication and may return 403 without it; public feeds can be read by actor. actor accepts a handle or DID."
},{
  "site": "coingecko.com",
  "auth": "Read-only access does not require sign-in.",
  "entry": { "api": "https://api.coingecko.com/api/v3/search?query={query}" },
  "recipes": ["coingecko-search"],
  "notes": "The public search endpoint returns {coins:[{id,name,symbol,market_cap_rank,thumb,...}],exchanges:[...],categories:[...],nfts:[...]}. No key is required; the public demo API has rate limits."
},{
  "site": "crates.io",
  "auth": "Read-only access does not require sign-in.",
  "entry": {
    "home": "https://crates.io/",
    "searchApi": "https://crates.io/api/v1/crates?q="
  },
  "recipes": ["crates-search"],
  "notes": "Search the public API at crates.io/api/v1/crates?q=&per_page=20. Navigate to the URL and read the body as JSON: {crates:[{name,description,max_version,downloads,homepage,repository,...}],meta:{total,...}}."
},{
  "site": "ctrip.com",
  "auth": "The gaHotelSearchEngine suggestion endpoint accepts anonymous requests. Use a same-origin POST from the persistent browser.",
  "entry": {
    "home": "https://m.ctrip.com/",
    "suggest": "POST https://m.ctrip.com/restapi/soa2/21881/json/gaHotelSearchEngine"
  },
  "recipes": ["ctrip-suggest"],
  "notes": "Navigate to https://m.ctrip.com/, then evaluate a same-origin fetch POST; navigation alone only sends GET. credentials:'include' can include cookies, but sign-in is not required. The request body uses {keyword:<query>,searchType:'D',platform:'online',pageID:'102001',head:{Locale:'zh-CN',Currency:'CNY',PageId:'102001',clientID:...,group:'ctrip',Frontend:{sessionID:1,pvid:1},HotelExtension:{group:'CTRIP',WebpSupport:false}}}. The response is {Response:{searchResults:[{displayName,word,cityName,displayType,type,commentScore,cStar,countryName}]}}. displayType is the localized category label, type may be City, and commentScore is the review score. These are destination, city, attraction, and hotel autocomplete results; they do not include bookable rooms or prices. Room prices and booking require authenticated hotel-list flows outside this suggestion recipe."
},{
  "site": "dev.to",
  "auth": "Read-only access does not require sign-in.",
  "entry": { "api": "https://dev.to/api/articles?tag={tag}&per_page=20" },
  "recipes": ["devto-articles"],
  "notes": "The public Articles endpoint returns a JSON array: [{title,url,description,published_at,tag_list,user:{name,username},positive_reactions_count,comments_count,...}]. per_page controls the result count."
},{
  "site": "developer.mozilla.org",
  "auth": "Read-only access does not require sign-in.",
  "entry": {
    "home": "https://developer.mozilla.org/",
    "searchApi": "https://developer.mozilla.org/api/v1/search?q="
  },
  "recipes": ["mdn-search"],
  "notes": "Search MDN's public API at developer.mozilla.org/api/v1/search?q=. Navigate to the URL and read {documents:[{title,slug,summary,locale,score,...}],metadata:{total,page,...}} from the body. Open documents at https://developer.mozilla.org/<locale>/docs/<slug>."
},{
  "site": "douban.com",
  "auth": "Most search and chart pages allow anonymous access. A signed-in persistent browser is more reliable; CAPTCHA challenges require user interaction.",
  "entry": {
    "search": "https://search.douban.com/{type}/subject_search?search_text={keyword}",
    "movieChart": "https://movie.douban.com/chart",
    "bookChart": "https://book.douban.com/chart"
  },
  "recipes": ["douban-search"],
  "notes": "Douban search uses server- and client-rendered DOM rather than a public JSON API. At search.douban.com/{type}/subject_search?search_text=, poll for .item-root before extraction; the recipe handles this wait. Card selectors are .title-text / .title a / a[title] for titles, the title anchor's href containing /subject/ for links, .rating_nums for ratings, and .meta.abstract / .meta / .abstract for summaries. type accepts movie, book, or music. Site changes can invalidate selectors. On failure, inspect the current page with snapshot/extract and update the recipe with saveRecipe. CAPTCHA challenges must be completed by the user in the persistent browser."
},{
  "site": "douyin.com",
  "auth": "Sign in to douyin.com in the persistent browser and fetch within the page. Web endpoints depend on session cookies and browser-generated a_bogus signatures; other requests may return non-JSON content or an access challenge.",
  "entry": {
    "home": "https://www.douyin.com/",
    "userPage": "https://www.douyin.com/user/<sec_uid>",
    "userVideosApi": "https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=<sec_uid>&max_cursor=0&count=20&aid=6383",
    "commentsApi": "https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=<aweme_id>&count=10&cursor=0&aid=6383"
  },
  "recipes": ["douyin-user-videos"],
  "notes": "Navigate to https://www.douyin.com/user/<sec_uid> and let the page initialize before evaluating fetch(api,{credentials:'include',headers:{referer:'https://www.douyin.com/'}}). Page requests supply the required browser signature and cookies; direct API navigation may return SPA HTML or an access challenge. User videos at /aweme/v1/web/aweme/post/?sec_user_id=&max_cursor=0&count=20&aid=6383 return {aweme_list:[{aweme_id,desc,video:{duration,play_addr:{url_list}},statistics:{digg_count}}]}; duration is in milliseconds. A nonzero status_code signals an error or access restriction. sec_uid is the final long segment of the user's profile URL. Comments at /aweme/v1/web/comment/list/?aweme_id=&count=10&cursor=0&aid=6383 return {comments:[{text,digg_count,user:{nickname}}]}. Access can still fail intermittently in an authenticated persistent browser; follow the reported error to retry or sign in again. Publishing, drafts, and account APIs under creator.douyin.com require a creator session and are outside this recipe."
},{
  "site": "facebook.com",
  "auth": "Use a signed-in persistent browser. Facebook often blocks unauthenticated or new sessions.",
  "entry": {
    "searchTop": "https://www.facebook.com/search/top?q={query}",
    "home": "https://www.facebook.com"
  },
  "recipes": ["facebook-search"],
  "notes": "Facebook search exposes rendered React content with obfuscated classes. Read coarse ARIA containers [role=article], with [role=listitem] as a fallback. The recipe navigates to the home domain, then /search/top?q=, waits 4 seconds for rendering, and keeps items with more than 20 text characters. It reads titles from h2/h3/h4/strong, links from a[href*=facebook.com/], and the first 150 characters of each container's textContent as the summary. Results are approximate because of DOM changes, login walls, and access challenges. If selectors fail, inspect the current page with snapshot/extract. Prefer direct page interaction when the authenticated session allows it."
},{
  "site": "finance.sina.com.cn",
  "auth": "News briefs and quotes can be read without sign-in.",
  "entry": {
    "home": "https://finance.sina.com.cn/",
    "newsApi": "https://app.cj.sina.com.cn/api/news/pc?page=1&size=<limit>&tag=0",
    "stockSuggestApi": "https://suggest3.sinajs.cn/suggest/type=11,31,41&key=<keyword>",
    "stockQuoteApi": "https://hq.sinajs.cn/list=<symbol>",
    "rollPage": "https://finance.sina.com.cn/roll/"
  },
  "recipes": ["sinafinance-news"],
  "notes": "The public news API at app.cj.sina.com.cn/api/news/pc?page=1&size=<limit>&tag=0 needs neither sign-in nor a browser signature. The sinafinance-news recipe navigates there and reads {result:{data:{feed:{list:[{id,create_time,rich_text,view_num}]}}}}; strip HTML from rich_text. Tag IDs are 10 for mainland China stocks, 1 for macroeconomics, 3 for companies, 4 for data, 5 for markets, 102 for international news, 6 for opinions/central banks, 8 for other news, and 0 for all.\nFor quotes, search symbols at suggest3.sinajs.cn/suggest/type=11,31,41&key=<name-or-code> (11 mainland China, 31 Hong Kong, 41 US), then fetch hq.sinajs.cn/list=<symbol>. These two endpoints use GBK and require Referer: https://finance.sina.com.cn. Use in-page fetch and new TextDecoder('gbk').decode(await r.arrayBuffer()) to avoid garbled text. Symbols use sh600519/sz300xxx for mainland China, hk<code> for Hong Kong, and gb_<code> for US stocks. The rolling-news page finance.sina.com.cn/roll/ uses the less stable SPA selector .d_list_txt li; this recipe reads the news-brief JSON endpoint."
},{
  "site": "finance.yahoo.com",
  "auth": "Read-only quotes do not require sign-in. The v8 chart endpoint accepts anonymous requests.",
  "entry": {
    "quoteApi": "https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?interval=1d&range=1d",
    "quotePage": "https://finance.yahoo.com/quote/<symbol>/"
  },
  "recipes": ["yahoo-finance-quote"],
  "notes": "GET https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?interval=1d&range=1d returns public JSON without cookies. Navigate there, read document.body.innerText, and JSON.parse it; yahoo-finance-quote unwraps the result into output. The response is {chart:{result:[{meta:{symbol,shortName,longName,regularMarketPrice,previousClose,chartPreviousClose,regularMarketDayHigh,regularMarketDayLow,regularMarketVolume,fiftyTwoWeekHigh,fiftyTwoWeekLow,currency,fullExchangeName,...},timestamp:[...],indicators:{quote:[{open,high,low,close,volume}]}}],error:null}}. Calculate price changes from price and previousClose; the endpoint does not supply them directly. Historical candles use range=5d/1mo/1y and interval=1d/1wk/1mo; pair timestamp with indicators.quote[0]. Example symbols: AAPL/MSFT, ^GSPC/^IXIC, BTC-USD, and EURUSD=X. query2.finance.yahoo.com is another host if query1 is rate-limited."
},{
  "site": "huggingface.co",
  "auth": "Read-only access does not require sign-in.",
  "entry": {
    "searchApi": "https://huggingface.co/api/models?search=&limit=20"
  },
  "recipes": ["hf-model-search"],
  "notes": "Navigate to the public Hugging Face API at huggingface.co/api/models?search=&limit=20 and read the body as a top-level JSON array: [{id,downloads,likes,pipeline_tag,library_name,createdAt,...}]. id is the model repository name; its page is https://huggingface.co/{id}. Add sort=downloads&direction=-1 to sort by downloads."
},{
  "site": "imdb.com",
  "auth": "Public search, detail, and chart pages do not require sign-in.",
  "entry": {
    "searchPage": "https://www.imdb.com/find/?q=<query>&ref_=nv_sr_sm&language=en-US",
    "titlePage": "https://www.imdb.com/title/<ttID>/?language=en-US",
    "namePage": "https://www.imdb.com/name/<nmID>/?language=en-US",
    "top250": "https://www.imdb.com/chart/top/?language=en-US",
    "mostPopular": "https://www.imdb.com/chart/moviemeter/?language=en-US"
  },
  "recipes": ["imdb-search"],
  "notes": "Navigate to the target page with language=en-US, then parse its embedded JSON.\nSearch /find/?q=<query> uses <script id=\"__NEXT_DATA__\">: props.pageProps.titleResults.results[] and nameResults.results[] contain {index:'tt0133093'|'nm...',listItem:{titleText/nameText/releaseYear/titleType,...}}. Data may appear after load; the imdb-search recipe polls for it and returns title/name results with id, kind, title, year, type, and url directly in output.\nTitle pages /title/<ttID>/ and charts /chart/top/ or /chart/moviemeter/ use <script type=\"application/ld+json\">. On title pages, select Movie, TVSeries, TVEpisode, or another relevant @type; fields include name, datePublished, aggregateRating.{ratingValue,ratingCount}, genre, director/creator, actor, duration (ISO, such as PT2H28M), contentRating, and description. Charts use @type='ItemList' with itemListElement[{position,item:{name,url,aggregateRating}}].\nTitle IDs start with tt and person IDs with nm, followed by 7–8 digits. A page title containing Robot Check or captcha indicates a challenge; use a normal browser session or retry later."
},{
  "site": "instagram.com",
  "auth": "Sign in to Instagram in the persistent browser. Internal endpoints require session cookies through in-page fetch with credentials:'include'; unauthenticated requests may return non-JSON content.",
  "entry": {
    "home": "https://www.instagram.com",
    "webProfileInfo": "https://www.instagram.com/api/v1/users/web_profile_info/?username=<username>",
    "topSearch": "https://www.instagram.com/web/search/topsearch/?query=<query>&context=user",
    "userFeed": "https://www.instagram.com/api/v1/feed/user/<userId>/?count=12"
  },
  "recipes": ["instagram-profile"],
  "notes": "First navigate to https://www.instagram.com. Fetch internal web endpoints from that page with credentials:'include' and {'X-IG-App-ID':'936619743392459'}, the public web app ID. Missing headers can cause 401/403; direct API navigation may return SPA HTML. instagram-profile reads users/web_profile_info and returns data.user fields username, full_name, biography, is_verified, is_private, id, edge_followed_by.count (followers), edge_follow.count (following), and edge_owner_to_timeline_media.count (posts). Its userId can be used for feed requests. Other endpoints use the same headers: web/search/topsearch/?query=<q>&context=user returns {users:[{user:{username,full_name,is_verified,is_private}}]}; api/v1/feed/user/<userId>/?count=12 returns {items:[{caption:{text},like_count,comment_count,media_type,taken_at}]}. media_type is 1 for images, 2 for videos, and 8 for multi-image posts. If JSON parsing fails, report a possible authentication or access challenge and ask the user to sign in through the persistent browser."
},{
  "site": "jd.com",
  "auth": "Sign in to JD in the persistent browser. Prices and detail images require the authenticated session and scrolling to trigger lazy loading.",
  "entry": {
    "itemPage": "https://item.jd.com/<sku>.html"
  },
  "recipes": ["jd-item"],
  "notes": "The jd-item recipe navigates to item.jd.com/<sku>.html, scrolls through the page to load prices, shops, and detail images, then extracts the DOM into output. Without sign-in, the price may be replaced by a login prompt. Selectors: .J-p-<sku> or .p-price strong for price, .sku-name / .product-title for title, .J-shop-name for shop, and img[src*=\"360buyimg.com\"] for product images; deduplicate image URLs and take a bounded number. Specifications are alternating key/value lines in document.body.innerText between the localized product-number and packing-list headings. sku is the numeric product ID in the URL, such as 100291143898 in https://item.jd.com/100291143898.html."
},{
  "site": "linkedin.com",
  "auth": "Use a signed-in persistent browser. The csrf-token header comes from the JSESSIONID cookie.",
  "entry": {
    "jobsVoyager": "/voyager/api/voyagerJobsDashJobCards?decorationId=...JobSearchCardsCollection-220&count=25&q=jobSearch&query=(origin:JOB_SEARCH_PAGE_OTHER_ENTRY,keywords:{kw},spellCorrectionEnabled:true)&start=0",
    "feed": "https://www.linkedin.com/feed/"
  },
  "recipes": ["linkedin-jobs-search"],
  "notes": "Call the internal Voyager API with in-page fetch, csrf-token set to the JSESSIONID cookie value without surrounding quotes, and x-restli-protocol-version:2.0.0. Job search uses voyagerJobsDashJobCards with a query DSL such as (origin:...,keywords:KW,...). Results are in elements[].jobCardUnion.jobPostingCard; titles use jobPostingTitle/title.text. Extract the numeric job ID from jobPostingUrn and open /jobs/view/{id}. This recipe searches jobs, not people or posts. LinkedIn may restrict accounts for automation; keep usage infrequent. Filters such as company, experience, jobType, and timePostedRange can be added to the query DSL in a recipe saved with saveRecipe."
},{
  "site": "linux.do",
  "auth": "Public Discourse topics return JSON without sign-in. A signed-in persistent browser can access permitted restricted categories and may reduce Cloudflare challenges.",
  "entry": {
    "home": "https://linux.do",
    "latest": "https://linux.do/latest.json",
    "top": "https://linux.do/top.json?period=<all|daily|weekly|monthly|quarterly|yearly>",
    "search": "https://linux.do/search.json?q=<keyword>",
    "topic": "https://linux.do/t/<topicId>.json",
    "categories": "https://linux.do/categories.json",
    "tags": "https://linux.do/tags.json",
    "userTopics": "https://linux.do/topics/created-by/<username>.json"
  },
  "pages": [
    {
      "type": "listing",
      "url": "https://linux.do/latest.json",
      "notes": "JSON {topic_list:{topics:[{id,title,fancy_title,posts_count,like_count,views,created_at,...}]}}. Topic URLs are https://linux.do/t/topic/<id>."
    }
  ],
  "recipes": ["linuxdo-latest"],
  "notes": "linux.do uses standard Discourse .json endpoints. Navigate to https://linux.do first, then evaluate fetch(relativePath,{credentials:'include'}) within the page; direct .json navigation can return a Cloudflare challenge or SPA HTML. Public content is readable anonymously, while restricted categories require an authorized session. linuxdo-latest reads /latest.json. Other endpoints use the same pattern: /top.json?period=weekly returns topic_list.topics (period accepts all/daily/weekly/monthly/quarterly/yearly); /search.json?q=<encodeURIComponent(keyword)> returns {topics:[{id,title,views,like_count,posts_count}]}; /t/<id>.json returns {post_stream:{posts:[{username,cooked,like_count,created_at,post_number}]}}. Strip HTML from cooked; post_number===1 is the original post. Categories use /categories.json with category_list.categories[{name,slug,id,topic_count}]; tags use /tags.json with tags[{id,name,slug,count}]; user topics use /topics/created-by/<username>.json. Reply count is posts_count - 1."
},{
  "site": "lobste.rs",
  "auth": "Read-only access does not require sign-in.",
  "entry": {
    "hottest": "https://lobste.rs/hottest.json",
    "newest": "https://lobste.rs/newest.json",
    "active": "https://lobste.rs/active.json",
    "tag": "https://lobste.rs/t/{tag}.json"
  },
  "recipes": ["lobsters-feed"],
  "notes": "Navigate directly to hottest.json, newest.json, or active.json and extract the body as a JSON array. Stories contain {short_id,title,url,score,comment_count,comments_url,created_at,submitter_user,tags,...}. Tag feeds use https://lobste.rs/t/{tag}.json. There is no usable search.json endpoint; it returns search-page HTML or may be rate-limited. Fetch a feed and filter locally for keywords."
},{
  "site": "m.okjike.com",
  "auth": "Public mobile profiles, posts, and topics can be read without sign-in from embedded Next.js data. Personalized feeds and search on web.okjike.com require sign-in and less stable React internals.",
  "entry": {
    "userMobile": "https://m.okjike.com/users/<username>",
    "postMobile": "https://m.okjike.com/originalPosts/<postId>",
    "topicMobile": "https://m.okjike.com/topics/<topicId>",
    "postWeb": "https://web.okjike.com/originalPost/<postId>"
  },
  "pages": [
    {
      "type": "user-posts",
      "url": "https://m.okjike.com/users/<username>",
      "notes": "The SSR <script type=\"application/json\"> contains props.pageProps.posts[{content,type,likeCount,commentCount,actionTime,createdAt,id}]. Post URLs are https://web.okjike.com/originalPost/<id>."
    }
  ],
  "recipes": ["jike-user-posts"],
  "notes": "Use the mobile site's Next.js SSR data. Read document.getElementById('__NEXT_DATA__') and JSON.parse its textContent to obtain props.pageProps; selecting this exact script is safer than taking the first application/json script. Public content requires no API request or sign-in. jike-user-posts reads /users/<username>. Other mobile pages use the same pattern: /originalPosts/<postId> contains pageProps.post{user.screenName,content,likeCount,createdAt} and pageProps.comments[{user.screenName,content,likeCount,createdAt}]; /topics/<topicId> contains pageProps.posts[{content,user.screenName,likeCount,commentCount,actionTime,id}]. Post URLs are https://web.okjike.com/originalPost/<id>. The authenticated web.okjike.com home feed (/) and search (/search?q=<kw>) are client-rendered. Reading them requires inspecting [class*=\"_post_\"] elements and React fiber properties whose keys start with __reactFiber$, then walking to memoizedProps containing data.id. This depends on changing DOM and class names; inspect the live page when needed rather than relying on the mobile recipe."
},{
  "site": "medium.com",
  "auth": "Public RSS content can be read without sign-in.",
  "entry": {
    "home": "https://medium.com",
    "tagFeed": "https://medium.com/feed/tag/<tag-slug>",
    "userFeed": "https://medium.com/feed/@<username>",
    "publicationFeed": "https://medium.com/feed/<publication>"
  },
  "recipes": ["medium-tag-feed"],
  "notes": "Use Medium's public RSS 2.0 feeds. Navigate to https://medium.com, fetch the RSS text within the page, and parse it as text/xml with DOMParser. Each <item> has title, link, guid, dc:creator, pubDate, category entries, and description. Read dc:creator with getElementsByTagName('dc:creator'); querySelector is unreliable for colon-containing tag names. Strip HTML from the CDATA description. medium-tag-feed reads /feed/tag/<slug>; other public feeds are /feed/@<username> and /feed/<publication-slug>. Search at /search?q= has no RSS or public JSON interface and requires less stable rendered DOM extraction. Prefer tag, author, or publication feeds. Tag slugs use hyphens, such as artificial-intelligence and machine-learning."
},{
  "site": "mp.weixin.qq.com",
  "auth": "Public article share links do not require sign-in. Open them in the persistent browser and allow page JavaScript to run; a spoofed WeChat user agent is unnecessary.",
  "entry": {
    "article": "https://mp.weixin.qq.com/s/<key>",
    "articleLegacy": "https://mp.weixin.qq.com/s?__biz=<biz>&mid=<mid>&idx=<idx>&sn=<sn>"
  },
  "recipes": ["wechat-article"],
  "notes": "Selectors: #activity-name for title, #js_name for account name, optional #js_author_name for author, #publish_time for the time populated by page JavaScript after load, and #js_content for the article. Images load lazily; read img[data-src] rather than src. Images on mmbiz.qpic.cn require Referer: https://mp.weixin.qq.com/ when fetched outside the browser. wechat-article returns article text, truncated after 40,000 characters with truncated set, and image URLs. There is no unauthenticated search or account-history API; the user must provide an article URL from a share or saved link. Missing #js_content can mean an expired temporary link (including chksm links), a removed or restricted article, or an access-verification page. Stop and inform the user if verification is required; do not repeatedly retry."
},{
  "site": "news.ycombinator.com",
  "auth": "Read-only access does not require sign-in.",
  "entry": {
    "home": "https://news.ycombinator.com/",
    "searchApi": "https://hn.algolia.com/api/v1/search?tags=story&query="
  },
  "pages": [
    { "type": "front", "url": "https://news.ycombinator.com/", "container": ".athing", "notes": "Titles are in .titleline a." }
  ],
  "recipes": ["hn-search"],
  "notes": "Search the public Algolia API at hn.algolia.com/api/v1/search?tags=story&query=. Navigate there and read the body as {hits:[{title,url,author,points,objectID,created_at,...}]}. The front-page DOM uses .athing rows."
},{
  "site": "npmjs.com",
  "auth": "Read-only access does not require sign-in.",
  "entry": {
    "home": "https://www.npmjs.com/",
    "searchApi": "https://registry.npmjs.org/-/v1/search?text="
  },
  "recipes": ["npm-search"],
  "notes": "Search the public npm registry API at registry.npmjs.org/-/v1/search?text=&size=20. Navigate there and read the body as {objects:[{package:{name,version,description,date,links,publisher,...}}],total,time}."
},{
  "site": "pixiv.net",
  "auth": "Sign in to pixiv.net in the persistent browser. Unauthenticated Ajax requests return 401/403.",
  "entry": {
    "home": "https://www.pixiv.net",
    "searchApi": "https://www.pixiv.net/ajax/search/illustrations/<word>?word=<word>&order=date_d&mode=all&p=1&s_mode=s_tag_full&type=illust_and_ugoira",
    "rankingApi": "https://www.pixiv.net/ranking.php?mode=daily&p=1&format=json",
    "illustApi": "https://www.pixiv.net/ajax/illust/<illustId>"
  },
  "recipes": ["pixiv-search"],
  "notes": "Navigate to https://www.pixiv.net, then fetch its same-origin Ajax endpoints with credentials:'include'. Responses use {error:false,body:...}; HTTP 401/403 indicates missing authentication and 404 indicates missing content. Search uses /ajax/search/illustrations/<word>?word=<word>&order=&mode=&p=&s_mode=s_tag_full&type=illust_and_ugoira; include the keyword in both the path and word parameter. order accepts date_d/date/popular_d/popular_male_d/popular_female_d; mode accepts all/safe/r18. Results are body.illust.data[{id,title,userName,userId,pageCount,bookmarkCount,tags[]}]. Rankings use /ranking.php?mode=daily|weekly|monthly|rookie|original|male|female&p=1&format=json and return contents[{rank,title,user_name,user_id,illust_id,illust_page_count,illust_bookmark_count}]. Details at /ajax/illust/<id> return body fields illustTitle, userName, pageCount, bookmarkCount, likeCount, viewCount, tags.tags[].tag, and createDate. To list an artist's works, read IDs from /ajax/user/<uid>/profile/all, then fetch /ajax/user/<uid>/profile/illusts?ids[]=...&work_category=illustManga in batches of at most 48 IDs. Artwork URLs are https://www.pixiv.net/artworks/<id>."
},{
  "site": "producthunt.com",
  "auth": "The public Atom feed does not require sign-in.",
  "entry": {
    "latest": "https://www.producthunt.com/feed",
    "byCategory": "https://www.producthunt.com/feed?category=<slug>"
  },
  "recipes": ["producthunt-feed"],
  "notes": "Use https://www.producthunt.com/feed for recent launches. Add ?category=<slug> to filter by categories such as ai-agents, ai-chatbots, developer-tools, productivity, design-creative, no-code-platforms, or vibe-coding. producthunt-feed takes no input and reads all recent launches; navigate directly to a category feed when filtering. Each Atom XML <entry> has <title>, <content> containing HTML with the tagline (strip tags and take the first paragraph), <author><name>, <published> (ISO; the first 10 characters are the date), and <link href>. Product Hunt uses Pacific time for daily launches; entries on the latest feed date are that day's launches. Rankings with vote counts and category leaderboards require DOM extraction from home/category pages and are outside this feed recipe."
},{
  "site": "pubmed.ncbi.nlm.nih.gov",
  "auth": "Read-only access does not require sign-in.",
  "entry": { "api": "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term={query}" },
  "recipes": ["pubmed-search"],
  "notes": "Use NCBI E-utilities esearch on the eutils host for PubMed search. It returns {esearchresult:{count,idlist:[PMID,...],querytranslation,...}}. Fetch esummary or efetch for details after obtaining idlist. Requests without a key are rate-limited."
},{
  "site": "pypi.org",
  "auth": "Read-only access does not require sign-in.",
  "entry": {
    "home": "https://pypi.org/",
    "packageApi": "https://pypi.org/pypi/<package>/json"
  },
  "recipes": ["pypi-package"],
  "notes": "Read a named package from the public API at pypi.org/pypi/<package>/json. Navigate there and parse {info:{name,version,summary,author,license,home_page,requires_python,...},releases:{...},urls:[...]}. This endpoint looks up an exact package name rather than searching keywords."
},{
  "site": "reddit.com",
  "auth": "Public content does not require sign-in. Restricted or personalized feeds, private communities, votes, and saved content require an authorized persistent-browser session.",
  "entry": {
    "home": "https://www.reddit.com",
    "subredditJson": "https://www.reddit.com/r/<subreddit>/hot.json?limit=25&raw_json=1"
  },
  "pages": [
    {
      "type": "listing",
      "url": "https://www.reddit.com/r/{subreddit}/hot.json?raw_json=1",
      "notes": "JSON {data:{children:[{data:{title,url,author,score,num_comments,subreddit_name_prefixed,permalink,...}}]}}"
    }
  ],
  "recipes": ["reddit-listing"],
  "notes": "Navigate to https://www.reddit.com, then evaluate fetch('/r/<sub>/hot.json?limit=25&raw_json=1',{credentials:'include'}) within the page. Direct .json navigation can return SPA HTML or an access challenge. The reddit-listing recipe handles this flow and returns the unwrapped array in output. Other endpoints use the same pattern: /hot.json, /r/<sub>/search.json?q=&restrict_sr=on, /r/<sub>/top.json?t=week, and /user/<name>/about.json. raw_json=1 disables HTML entity escaping. An authenticated session can provide personalized results."
},{
  "site": "reuters.com",
  "auth": "Use the persistent browser with session cookies. Reuters applies access challenges, regional restrictions, and paywalls; blocked or unauthenticated requests may return non-JSON content.",
  "entry": {
    "home": "https://www.reuters.com",
    "searchApi": "https://www.reuters.com/pf/api/v3/content/fetch/articles-by-search-v2?query=<urlencoded-json>"
  },
  "recipes": ["reuters-search"],
  "notes": "Search uses /pf/api/v3/content/fetch/articles-by-search-v2?query=<urlencoded-json>, where the JSON is {keyword,offset:0,orderby:'display_date:desc',size,website:'reuters'}. The response is {result:{articles:[{title or headlines.basic,display_date,taxonomy.section.name,canonical_url}],...}}. display_date is ISO; canonical_url is relative to https://www.reuters.com. Navigate to the home page first, then fetch within it with credentials:'include'; direct cross-origin requests may be blocked. On an access challenge, the recipe asks the user to open or sign in to Reuters in the persistent browser. If access remains unavailable, a public RSS source such as BBC is an alternative."
},{
  "site": "scrapethissite.com",
  "auth": "No sign-in is required for this public scraping practice site.",
  "entry": {
    "forms": "https://www.scrapethissite.com/pages/forms/"
  },
  "recipes": ["hockey-search"],
  "notes": "The hockey-search recipe demonstrates interactive steps: type and submit a form, then extract results. This sandbox can also exercise the recipe engine end to end."
},{
  "site": "smzdm.com",
  "auth": "Anonymous search is available, but a signed-in persistent browser may return more complete results with fewer access challenges.",
  "entry": {
    "home": "https://www.smzdm.com/",
    "searchPage": "https://search.smzdm.com/?c=home&s=<keyword>&v=b"
  },
  "recipes": ["smzdm-search"],
  "notes": "Navigate to search.smzdm.com/?c=home&s=<keyword>&v=b and extract the rendered DOM. There is no usable public JSON search endpoint; search.smzdm.com/ajax/ returns 404. smzdm-search reads li.feed-row-wide: the title attribute and href of h5.feed-block-title a, .z-highlight text for price, and .z-feed-foot-r .feed-block-extras span text for the store. Comment counts are embedded in .feed-btn-comment text and are not returned separately by this recipe. Use the persistent browser for more complete authenticated results. If selectors stop matching, inspect a snapshot scoped to li.feed-row-wide before changing them."
},{
  "site": "stackoverflow.com",
  "auth": "Read-only access does not require sign-in.",
  "entry": {
    "searchApi": "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=&site=stackoverflow"
  },
  "recipes": ["stackoverflow-search"],
  "notes": "Search the public Stack Exchange API at api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=&site=stackoverflow. Navigate there and read {items:[{title,link,score,answer_count,is_answered,question_id,tags,...}],has_more,quota_remaining}. Browsers decompress the default gzip response automatically. Requests without a key have a lower quota, reported in quota_remaining. Change site to search another Stack Exchange site."
},{
  "site": "store.steampowered.com",
  "auth": "Store search and featured categories accept anonymous requests.",
  "entry": {
    "home": "https://store.steampowered.com/",
    "search": "https://store.steampowered.com/api/storesearch/?cc=us&l=english&term=<keyword>",
    "featured": "https://store.steampowered.com/api/featuredcategories/?cc=us&l=english"
  },
  "recipes": ["steam-search"],
  "notes": "Two public endpoints are available. /api/storesearch/?cc=<country-code>&l=english&term=<query> returns {total,items:[{id,type,name,price:{currency,initial,final},metascore,platforms:{windows,mac,linux},tiny_image,controller_support}]}; id is the AppID and price.final is an integer in the currency's smallest unit (999 is $9.99 for USD). /api/featuredcategories/?cc=&l= returns featured content; top_sellers.items[{id,name,final_price,original_price,discount_percent,currency,header_image}] contains bestsellers. cc selects regional pricing (us/cn/jp, for example), and l selects the language. Both return JSON anonymously. The recipe first navigates to store.steampowered.com, then uses same-origin evaluate fetch to handle occasional region or access gates. Product pages use https://store.steampowered.com/app/<AppID>."
},{
  "site": "substack.com",
  "auth": "Public search and browsing do not require sign-in. Paid or subscriber-only content requires an authorized persistent-browser session.",
  "entry": {
    "home": "https://substack.com",
    "postSearch": "https://substack.com/api/v1/post/search?query=<kw>&page=0&includePlatformResults=true",
    "profileSearch": "https://substack.com/api/v1/profile/search?query=<kw>&page=0"
  },
  "recipes": ["substack-search"],
  "notes": "Navigate to https://substack.com, then fetch its same-origin JSON endpoints within the page; direct API navigation may return SPA HTML. Article search uses /api/v1/post/search?query=&page=0&includePlatformResults=true and returns {results:[{title,publishedBylines:[{name}],post_date,description/subtitle/truncated_body_text,canonical_url}]}; post_date is ISO. Author/newsletter search uses /api/v1/profile/search?query=&page=0 and returns {results:[{name,bio,primaryPublication:{name,hero_text,subdomain,custom_domain}}]}. A newsletter's home is https://<custom_domain> when present, otherwise https://<subdomain>.substack.com. substack-search uses post/search; a profile-search recipe can use profile/search instead. Publication archives are JSON arrays at https://<pub>.substack.com/api/v1/archive?sort=new&limit=20."
},{
  "site": "tieba.baidu.com",
  "auth": "The hot-topic list is public. Search, forum threads, and thread content require session cookies and depend on changing DOM structures; Baidu may show a security challenge.",
  "entry": {
    "home": "https://tieba.baidu.com",
    "hotTopics": "https://tieba.baidu.com/hottopic/browse/topicList?res_type=1",
    "forum": "https://tieba.baidu.com/f?kw=<forum-name>&pn=<(page-1)*50>",
    "search": "https://tieba.baidu.com/f/search/res?qw=<keyword>&pn=1",
    "thread": "https://tieba.baidu.com/p/<threadId>?pn=<page>"
  },
  "pages": [
    {
      "type": "hot-list",
      "url": "https://tieba.baidu.com/hottopic/browse/topicList?res_type=1",
      "notes": "Server-rendered li.topic-top-item entries contain a.topic-text for the title and topic URL, span.topic-num for discussion volume, and p.topic-top-item-desc for the summary."
    }
  ],
  "recipes": ["tieba-hot-topics"],
  "notes": "tieba-hot-topics reads the public, server-rendered /hottopic/browse/topicList?res_type=1 page. Navigate there and extract li.topic-top-item with its child selectors. Other flows depend on private signatures or framework internals and require live-page inspection. Search at /f/search/res?qw=<encodeURIComponent(kw)>&pn=1 renders Vue cards at .threadcardclass.thread-new3.index-feed-cards; thread_id lives in the action bar's __vue__ props under businessInfo.thread_id, so visible DOM alone is insufficient and security challenges are common. Forum lists at /f?kw=<forum-name> obtain data through POST tieba.baidu.com/c/f/frs/page_pc with a private sign parameter that declarative recipes cannot generate. Thread content at /p/<id> resides in Vue __vue__ props on nodes such as .pb-content-wrap and .pb-comment-item; DOM changes can break extraction. Use a signed-in persistent browser and normal page navigation for these authenticated flows."
},{
  "site": "v2ex.com",
  "auth": "Public topics, replies, nodes, and profiles use the official JSON API without sign-in. Write operations such as daily check-in require authentication.",
  "entry": {
    "home": "https://www.v2ex.com",
    "hot": "https://www.v2ex.com/api/topics/hot.json",
    "latest": "https://www.v2ex.com/api/topics/latest.json",
    "topic": "https://www.v2ex.com/api/topics/show.json?id=<topicId>",
    "node": "https://www.v2ex.com/api/topics/show.json?node_name=<node>",
    "replies": "https://www.v2ex.com/api/replies/show.json?topic_id=<topicId>",
    "nodes": "https://www.v2ex.com/api/nodes/all.json",
    "member": "https://www.v2ex.com/api/members/show.json?username=<name>"
  },
  "pages": [
    {
      "type": "listing",
      "url": "https://www.v2ex.com/api/topics/hot.json",
      "notes": "Returns an array: [{id,title,url,replies,node:{title,name},member:{username},created,...}]."
    }
  ],
  "recipes": ["v2ex-hot"],
  "notes": "V2EX's public v1 endpoints return raw JSON through direct navigation; sign-in and in-page fetch are unnecessary. v2ex-hot reads popular topics. Other endpoints are /api/topics/latest.json for latest topics; /api/topics/show.json?id=<id> for a one-element topic array with title, content, member.username, node.title, replies, and url; /api/topics/show.json?node_name=<node> for up to 20 topics in a node such as python or apple; /api/replies/show.json?topic_id=<id> for replies with member.username, content, and created; /api/nodes/all.json for nodes with name, title, topics, and stars; and /api/members/show.json?username=<name> for a profile. Use each response's item.url for the topic page."
},{
  "site": "weibo.com",
  "auth": "Sign in to weibo.com in the persistent browser. Unauthenticated Ajax requests may return non-JSON content or ok=false.",
  "entry": {
    "home": "https://weibo.com",
    "hotBand": "https://weibo.com/ajax/statuses/hot_band",
    "searchPage": "https://s.weibo.com/weibo?q=<keyword>"
  },
  "recipes": ["weibo-hot"],
  "notes": "Navigate to https://weibo.com, then evaluate fetch('/ajax/statuses/hot_band',{credentials:'include'}) within the page. Direct API navigation or an unauthenticated session may return SPA HTML. The response is {ok:1,data:{band_list:[{realpos,word,num,category,label_name}]}}. Build hashtag-search links as https://s.weibo.com/weibo?q=%23<word>%23. Search on s.weibo.com requires DOM extraction; the home feed at /ajax/feed/unreadfriendstimeline also requires the user's UID. The weibo-hot recipe reads hot_band. Use the authenticated persistent browser."
},{
  "site": "weread.qq.com",
  "auth": "Public search and rankings do not require sign-in. Book details at i.weread.qq.com require a WeRead session in the persistent browser.",
  "entry": {
    "home": "https://weread.qq.com/",
    "searchApi": "https://weread.qq.com/web/search/global?keyword=<keyword>",
    "rankingApi": "https://weread.qq.com/web/bookListInCategory/<category>?rank=1",
    "bookInfoApi": "https://i.weread.qq.com/book/info?bookId=<bookId>"
  },
  "recipes": ["weread-search"],
  "notes": "Public endpoints under weread.qq.com/web/* return JSON without sign-in. Search at /web/search/global?keyword= returns {books:[{bookInfo:{title,author,bookId,category}}]}; weread-search navigates directly and reads the body. Rankings at /web/bookListInCategory/<category>?rank=1 accept all, rising, or a numeric category ID and return {books:[{bookInfo:{title,author,bookId},readingCount}]}. Book details require authentication: navigate to https://weread.qq.com/, then evaluate fetch('https://i.weread.qq.com/book/info?bookId='+id,{credentials:'include',headers:{Origin:'https://weread.qq.com',Referer:'https://weread.qq.com/'}}). The response includes title, author, publisher, category, intro, and newRating. errcode -2010/-2012 indicates that the user must sign in again. Personalized bookshelves and notes depend on less stable localStorage snapshots and DOM extraction and are outside this recipe."
},{
  "site": "wikipedia.org",
  "auth": "Read-only access does not require sign-in.",
  "entry": {
    "searchApi": "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=&srlimit=20&format=json&utf8=1"
  },
  "recipes": ["wikipedia-search"],
  "notes": "Navigate to the public MediaWiki API at /w/api.php?action=query&list=search&srsearch=&srlimit=20&format=json&utf8=1 and read {query:{search:[{title,snippet,pageid,size,wordcount,timestamp,...}]}} from the body. srlimit controls the result count (default 10, maximum 50); utf8=1 preserves non-ASCII output. snippet contains HTML highlighting. Article URLs use https://<lang>.wikipedia.org/wiki/<title>, with spaces replaced by underscores. Replace en. with another language subdomain as needed."
},{
  "site": "www.coupang.com",
  "auth": "Sign in to coupang.com in the persistent browser. Unauthenticated or non-browser search requests may encounter Akamai challenges or receive HTML.",
  "entry": {
    "home": "https://www.coupang.com/",
    "searchPage": "https://www.coupang.com/np/search?q=<keyword>&channel=user&page=1",
    "searchJson": "https://www.coupang.com/np/search?q=<keyword>&channel=user&page=<n>"
  },
  "recipes": ["coupang-search"],
  "notes": "Navigate to https://www.coupang.com/np/search?q=<query>&channel=user&page=1 to establish the browser session, then evaluate fetch('/np/search?q=<query>&channel=user&page=<n>',{credentials:'include'}) within the page. Direct search-API requests can be blocked. For JSON responses, product arrays may be in data.products, data.productList, products, productList, or items. Common fields include productId, title/name/productName, price/salePrice/finalPrice, originalPrice/basePrice, rating, and reviewCount. If responseText begins with '<', report an authentication or access challenge instead of treating the HTML as results. Product pages are https://www.coupang.com/vp/products/<productId>. The recipe reads the JSON response; JSON-LD, __NEXT_DATA__, and DOM extraction are more dependent on page structure."
},{
  "site": "www.xiaoyuzhoufm.com",
  "auth": "Public content does not require sign-in. Pages embed Next.js data in <script id=\"__NEXT_DATA__\"> after loading in the browser.",
  "entry": {
    "podcast": "https://www.xiaoyuzhoufm.com/podcast/<podcastId>",
    "episode": "https://www.xiaoyuzhoufm.com/episode/<episodeId>"
  },
  "recipes": ["xiaoyuzhou-podcast"],
  "notes": "Use known podcast or episode IDs from the site's URL paths; there is no stable public search endpoint. Navigate to /podcast/<id> or /episode/<id>, wait for load, then evaluate window.__NEXT_DATA__.props.pageProps. Direct ajax/api subdomain requests require authentication headers. Podcast pages expose pageProps.podcast with title, author, brief, subscriptionCount, episodeCount, latestEpisodePubDate, and episodes[{eid,title,duration,playCount,pubDate}]; SSR includes roughly the latest 15 episodes. Episode pages expose pageProps.episode with title, podcast:{title}, duration, playCount, commentCount, clapCount, and pubDate. duration is in seconds; clapCount is the like count. An invalid ID may lead to /404 with empty pageProps, including when fetched with curl. Use a valid ID in the browser."
},{
  "site": "wx.zsxq.com",
  "auth": "Sign-in required: Zsxq uses httpOnly cookies across zsxq.com subdomains, so document.cookie cannot determine authentication state; check whether an API call returns JSON. After signing in to wx.zsxq.com in the persistent browser, authenticated in-page fetch requests carry the session automatically.",
  "entry": {
    "home": "https://wx.zsxq.com",
    "dynamics": "https://api.zsxq.com/v2/dynamics?scope=general&count=<n>",
    "groups": "https://api.zsxq.com/v2/groups",
    "groupTopics": "https://api.zsxq.com/v2/groups/<groupId>/topics?scope=all&count=<n>",
    "search": "https://api.zsxq.com/v2/search/groups/<groupId>/topics?keyword=<kw>&count=<n>",
    "topic": "https://api.zsxq.com/v2/topics/<topicId>",
    "topicComments": "https://api.zsxq.com/v2/topics/<topicId>/comments?sort=asc&count=<n>"
  },
  "pages": [
    {
      "type": "feed",
      "url": "https://api.zsxq.com/v2/dynamics?scope=general&count=20",
      "notes": "Response: {resp_data:{dynamics:[{create_time,action,topic:{topic_id,type,group:{name},owner:{name},title,talk:{text,owner},comments_count,likes_count}}]}}. Topic URL: https://wx.zsxq.com/topic/<topic_id>."
    }
  ],
  "recipes": ["zsxq-dynamics"],
  "notes": "Zsxq pages are hosted on wx.zsxq.com; the data API is on api.zsxq.com. First navigate to https://wx.zsxq.com, then use an evaluate step to fetch the full api.zsxq.com URL within the page with {credentials:'include'}. Cookies are httpOnly and span subdomains, so authenticated in-page requests are required to carry the session. Responses use a wrapper: successful data is in resp_data (or data); failures return {succeeded:false,code,info}. For the body, take the first nonempty value from topic.title / talk.text / question.text / answer.text / task.text / solution.text. The zsxq-dynamics recipe reads recent activity across all groups without a group_id. Other read workflows require group_id: list joined groups at api.zsxq.com/v2/groups (resp_data.groups[{group_id,name,category:{title},statistics:{subscriptions_count,topics_count},user_specific:{join_time}}]); list group topics at api.zsxq.com/v2/groups/<groupId>/topics?scope=all&count=<n>; search within a group at api.zsxq.com/v2/search/groups/<groupId>/topics?keyword=<encodeURIComponent(kw)>&count=<n>; read a topic at api.zsxq.com/v2/topics/<topicId> (resp_data.topic or the top-level topic); read comments at api.zsxq.com/v2/topics/<topicId>/comments?sort=asc&count=<n> (resp_data.comments[{owner:{name},text,repliee:{name},likes_count}]). The active group's group_id is also available from the page's localStorage target_group value: JSON.parse it and read group_id."
},{
  "site": "x.com",
  "auth": "Sign in to x.com in the persistent browser. Internal GraphQL endpoints authenticate with session cookies and the ct0 cookie value as a CSRF token.",
  "entry": {
    "home": "https://x.com",
    "userByScreenName": "https://x.com/i/api/graphql/<queryId>/UserByScreenName?variables=...&features=...",
    "homeTimeline": "https://x.com/i/api/graphql/<queryId>/HomeTimeline?variables=...&features=..."
  },
  "recipes": ["twitter-profile"],
  "notes": "For a public post, use the x-tweet recipe on api.fxtwitter.com; public profiles are available at api.fxtwitter.com/<screen_name>. These paths do not require an x.com session. Timelines, search, and reply lists use x.com's internal GraphQL at /i/api/graphql/<queryId>/<Operation>. First navigate to https://x.com, then in the same evaluate function: read ct0 from document.cookie for X-Csrf-Token; build Authorization with the web client's fixed public bearer included in the recipe; set X-Twitter-Auth-Type:OAuth2Session and X-Twitter-Active-User:yes; and fetch the GraphQL endpoint with credentials:include. The bearer is a public web-client value, not a private user token. twitter-profile wraps UserByScreenName and returns {screen_name,name,bio,location,followers,following,tweets,likes,verified,created_at,url}. queryId values change with web-client versions. If the recipe's known queryId returns non-JSON or a queryId expired error, find the current ID paired with 'queryId:\"...\"' and 'operationName:\"UserByScreenName\"' in the loaded client-web *.js bundle. Other endpoints use the same pattern: HomeTimeline (for-you, GET) / HomeLatestTimeline (following, POST) return data.home.home_timeline_urt.instructions[].entries[].content.itemContent.tweet_results.result; read legacy.full_text/favorite_count/retweet_count and use a pagination cursor. SearchTimeline uses SPA XHR with a changing queryId; reproducing it with fetch alone is unreliable, so prefer profile or timeline reads."
},{
  "site": "xiaohongshu.com",
  "auth": "Sign in through the persistent browser. Otherwise the search page displays a wall asking you to sign in to view results.",
  "entry": {
    "searchNotes": "https://www.xiaohongshu.com/search_result?keyword={kw}&source=web_search_result_notes",
    "explore": "https://www.xiaohongshu.com/explore"
  },
  "recipes": ["xiaohongshu-search"],
  "notes": "Xiaohongshu's web API (edith.xiaohongshu.com/.../search/notes) requires x-s/x-t signature headers generated by the page's obfuscated window._webmsxyw JavaScript. Unprepared fetch requests are rejected; read the rendered DOM. The recipe navigates to the search page, detects the sign-in wall, scrolls three times, then extracts section.note-item while skipping .query-note-item. Title: .title/.note-title/a.title/.footer .title span; author: a.author .name/.name/.nick-name; likes: .count/.like-count; link: a.cover.mask or an anchor whose href contains /search_result/, /explore/, or /note/. A signed-in session is required. If selectors break after a site update, fail promptly, inspect a live snapshot with extract, and update the recipe with saveRecipe as needed."
},{
  "site": "xueqiu.com",
  "auth": "Sign in to xueqiu.com in the persistent browser. Quote and activity endpoints require session cookies; unauthenticated requests may return non-JSON content or HTTP 400.",
  "entry": {
    "home": "https://xueqiu.com",
    "search": "https://xueqiu.com/stock/search.json?code=<keyword>&size=<n>",
    "quote": "https://stock.xueqiu.com/v5/stock/batch/quote.json?symbol=<SYMBOL>",
    "hotStock": "https://stock.xueqiu.com/v5/stock/hot_stock/list.json?size=<n>&type=<10-popularity|12-following>",
    "hotStatus": "https://xueqiu.com/statuses/hot/listV3.json?source=hot&page=1",
    "feed": "https://xueqiu.com/v4/statuses/home_timeline.json?page=<p>&count=<n>",
    "watchlist": "https://stock.xueqiu.com/v5/stock/portfolio/stock/list.json?size=100&category=<1-watchlist|2-holdings|3-following>&pid=-1",
    "earningsDate": "https://stock.xueqiu.com/v5/stock/screener/event/list.json?symbol=<SYMBOL>&page=1&size=100"
  },
  "pages": [
    {
      "type": "search",
      "url": "https://xueqiu.com/stock/search.json?code=<keyword>&size=10",
      "notes": "JSON: {stocks:[{code,name,exchange(SH/SZ/BJ/...),current,percentage}]}. Shanghai, Shenzhen, and Beijing stock symbols require the exchange prefix, such as SH600519. Detail page: https://xueqiu.com/S/<symbol>."
    }
  ],
  "recipes": ["xueqiu-search-stock"],
  "notes": "Navigate to https://xueqiu.com, then evaluate fetch with the full endpoint URL and {credentials:'include'} within the page. Direct *.json navigation may return SPA HTML or an access block and does not establish the session. xueqiu-search-stock searches by code or name. Other endpoints use the same in-page pattern: live quotes at stock.xueqiu.com/v5/stock/batch/quote.json?symbol=<SH600519|AAPL|00700> return data.items[0].quote fields current/chg/percent/open/high/low/last_close/volume/amount/market_capital; popular stocks at stock.xueqiu.com/v5/stock/hot_stock/list.json?size=<n>&type=10 return data.items[{symbol,name,current,percent,value}], where value is popularity. Popular posts at xueqiu.com/statuses/hot/listV3.json?source=hot&page=1 return list[{id,description,user:{id,screen_name},fav_count,retweet_count,reply_count}]; strip HTML from description and build https://xueqiu.com/<user.id>/<id>. The authenticated home timeline at xueqiu.com/v4/statuses/home_timeline.json?page=1&count=20 returns home_timeline or list with the same post structure. Watchlists at stock.xueqiu.com/v5/stock/portfolio/stock/list.json?size=100&category=1&pid=-1 return data.stocks[{symbol,name,current,chg,percent}]. Estimated earnings dates at stock.xueqiu.com/v5/stock/screener/event/list.json?symbol=<SYMBOL>&page=1&size=100 return data.items; subtype===2 means an estimated release and timestamp is in milliseconds. Use SH/SZ/BJ prefixes for Shanghai, Shenzhen, and Beijing, five-digit codes for Hong Kong, and ticker symbols for US stocks."
},{
  "site": "youtube.com",
  "auth": "Read-only search and video metadata do not require sign-in. Personalized results and subscriptions use the persistent browser's signed-in session.",
  "entry": {
    "home": "https://www.youtube.com",
    "results": "https://www.youtube.com/results?search_query=<kw>",
    "watch": "https://www.youtube.com/watch?v=<videoId>"
  },
  "recipes": ["youtube-search"],
  "notes": "Search results are embedded in window.ytInitialData. youtube-search navigates to https://www.youtube.com/results?search_query=<query>, waits for load, then reads ytInitialData.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[].itemSectionRenderer.contents[].videoRenderer. Fields are title.runs[0].text, ownerText.runs[0].text (channel), viewCountText.simpleText (views), lengthText.simpleText (duration), publishedTimeText.simpleText (publication time), and videoId for the watch URL. Add &sp=<token> for a type/upload/sort protobuf filter; only one token can be used at a time. Video details are in window.ytInitialPlayerResponse.videoDetails on the watch page: title/author/viewCount/lengthSeconds/shortDescription/keywords. Channel information requires a POST to innertube /youtubei/v1/browse with INNERTUBE_API_KEY and INNERTUBE_CONTEXT from window.ytcfg.data_. This recipe reads regular videoRenderer entries; reelItemRenderer (Shorts) uses a different structure."
},{
  "site": "zhihu.com",
  "auth": "Sign in to zhihu.com in the persistent browser. Unauthenticated or abnormal sessions may receive non-JSON content or an access block.",
  "entry": {
    "home": "https://www.zhihu.com",
    "searchV3": "https://www.zhihu.com/api/v4/search_v3?t=general&offset=0&limit=<limit>&q=<keyword>",
    "hotList": "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50"
  },
  "recipes": ["zhihu-search"],
  "notes": "Navigate to https://www.zhihu.com, then evaluate fetch with the full API URL and {credentials:'include'} within the page. Direct API navigation may receive SPA HTML or an access challenge. zhihu-search calls /api/v4/search_v3?t=general&offset=0&limit=<n>&q=<encodeURIComponent(keyword)> and reads {data:[{type:'search_result',object:{type,title,excerpt,voteup_count,author:{name},id,question:{id,name}}}]}. Keep only type==='search_result'. Build URLs by object.type: answer → /question/<qid>/answer/<id>; article → zhuanlan.zhihu.com/p/<id>; otherwise → /question/<id>. The separate hot-list endpoint /api/v3/feed/topstory/hot-lists/total?limit=50 returns data[].target.{title,answer_count,follower_count} and popularity text in detail_text. Hot-list question IDs have 16 or more digits; JSON.parse can lose precision. Convert numeric \"id\":<digits> values to strings before parsing. The search recipe does not read this hot list. Use the authenticated persistent browser."
}];
