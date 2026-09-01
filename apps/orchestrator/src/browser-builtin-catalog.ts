/**
 * Built-in browser knowledge kept as capability-neutral product data.
 *
 * The bridge validates every entry before exposing it. Keeping the catalog
 * static guarantees that production never reads development-only files.
 */
export const BUILTIN_BROWSER_RECIPES: readonly unknown[] = [{
  "id": "36kr-news",
  "match": ["36kr.com"],
  "description": "读取 36 氪最新科技/创投资讯(RSS 输出 XML:标题/链接/发布时间/摘要)。走公开 RSS 源 www.36kr.com/feed,无需登录。结果是 RSS XML 文本,逐个 <item> 解析 title/link/pubDate/description。",
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
  "description": "免登录读取单条 X(Twitter)公开推文:正文/作者/互动数/媒体/引用。走 FxTwitter 公开 API(无需登录、无需 API key),id 传推文数字 id(URL 里 /status/ 后面那串),**必须作为字符串传入**——19 位雪花 id 超出 JSON number 安全整数范围,传数字会丢精度。私密与已删推文取不到;时间线/搜索见 x.com 的 siteguide(需登录)。",
  "inputs": { "id": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://api.fxtwitter.com/status/{{id|url}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "tweet",
      "fn": "() => { let d; try { d = JSON.parse(document.body.innerText); } catch (e) { throw new Error('fxtwitter 返回非 JSON(可能被网络设备拦截或服务异常),页面开头:' + document.body.innerText.slice(0, 200)); } if (!d.tweet) throw new Error('未找到推文(code ' + d.code + ' ' + d.message + '):id 是否正确?私密/已删推文取不到;注意 id 必须以字符串传入,JSON number 会对 19 位雪花 id 丢精度'); const t = d.tweet; if (String(t.id) !== '{{id|js}}') throw new Error('返回的推文 id(' + t.id + ')与请求 id({{id|js}})不一致——id 很可能因以 JSON number 传入而丢精度,请改为字符串重试'); const a = t.author || {}; const m = t.media || {}; const media = (m.photos || []).map(p => ({ type: 'photo', url: p.url })).concat((m.videos || []).map(v => ({ type: v.type || 'video', url: v.url, thumbnail: v.thumbnail_url }))); return { url: t.url, id: t.id, text: t.text, lang: t.lang, created_at: t.created_at, author: { name: a.name, screen_name: a.screen_name, followers: a.followers }, replies: t.replies, retweets: t.retweets, likes: t.likes, quotes: t.quotes, bookmarks: t.bookmarks, views: t.views, replying_to: t.replying_to, media, quote: t.quote ? { text: t.quote.text, author: t.quote.author && t.quote.author.screen_name, url: t.quote.url } : null }; }"
    }
  ],
  "output": "{{tweet}}"
},{
  "id": "arxiv-search",
  "match": ["arxiv.org", "export.arxiv.org"],
  "description": "用 arXiv 公开 API 搜索论文,返回 Atom XML 文本(标题/作者/摘要)。读接口而非扒页面。",
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
  "description": "查询某只股票在 Barchart 的行情与关键指标(价格、涨跌、当日开高低、前收、成交量、均量、市值、市盈率、每股收益)。Barchart 的行情走站内 proxy 接口,需要页面里的 CSRF token + 登录会话 cookie——所以先 navigate 到该股 overview 页,再在页面内同源 fetch。symbol 用交易代码(如 AAPL)。需要先在持久浏览器登录 barchart.com。",
  "inputs": { "symbol": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.barchart.com/stocks/quotes/{{symbol}}/overview" },
    { "action": "wait", "loadState": "load" },
    { "action": "evaluate", "as": "quote", "fn": "async () => { const csrf = (document.querySelector('meta[name=\"csrf-token\"]') || {}).content || ''; if (!csrf) throw new Error('未取到 Barchart 的 CSRF token,通常是页面没加载完或未登录,请先在持久浏览器登录 barchart.com 后重试'); const fields = ['symbol','symbolName','lastPrice','priceChange','percentChange','openPrice','highPrice','lowPrice','previousPrice','volume','averageVolume','marketCap','peRatio','earningsPerShare','tradeTime'].join(','); const r = await fetch('/proxies/core-api/v1/quotes/get?symbol=' + encodeURIComponent('{{symbol|js}}'.toUpperCase()) + '&fields=' + fields, { credentials: 'include', headers: { 'X-CSRF-TOKEN': csrf } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch(e) { throw new Error('Barchart 接口返回非 JSON(未登录或被风控),请在持久浏览器登录该站后重试'); } const row = d && d.data && d.data[0]; if (!row) throw new Error('未取到该股行情(代码可能不存在或市场休市)'); const v = row.raw || row; return { symbol: v.symbol, name: v.symbolName, price: v.lastPrice, change: v.priceChange, changePercent: v.percentChange, open: v.openPrice, high: v.highPrice, low: v.lowPrice, previousClose: v.previousPrice, volume: v.volume, avgVolume: v.averageVolume, marketCap: v.marketCap, peRatio: v.peRatio, eps: v.earningsPerShare, tradeTime: v.tradeTime }; }" }
  ],
  "output": "{{quote}}"
},{
  "id": "bbc-news-feed",
  "match": ["bbc.com", "www.bbc.com", "bbc.co.uk"],
  "description": "读取 BBC News 某个板块的头条列表(标题/摘要/链接/发布时间)。走 BBC 官方公开 RSS,无需登录。section 填板块路径,如 news(全站)、news/world、news/technology、news/business、sport。返回的是 RSS XML 文本,每条 <item> 含 <title>/<description>/<link>/<pubDate>。",
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
  "description": "读取 B 站综合热门视频列表(排名/标题/UP主/播放量/弹幕数/链接)。先落到 bilibili.com 域,再在页面内同源 fetch JSON——带上登录 cookie、不被风控挡(直接 navigate 到 api 子域会被喂 SPA HTML)。",
  "inputs": { "limit": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.bilibili.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "videos",
      "fn": "async () => { const r = await fetch('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=' + encodeURIComponent('{{limit|js}}'), { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('B站返回非 JSON(被风控挡或未登录),请在持久浏览器里正常访问/登录该站后重试'); } return (d && d.data && d.data.list ? d.data.list : []).map((v, i) => ({ rank: i + 1, title: v.title, author: v.owner && v.owner.name, play: v.stat && v.stat.view, danmaku: v.stat && v.stat.danmaku, url: v.bvid ? 'https://www.bilibili.com/video/' + v.bvid : '' })); }"
    }
  ],
  "output": "{{videos}}"
},{
  "id": "sinablog-search",
  "match": ["blog.sina.com.cn", "search.sina.com.cn"],
  "description": "搜索新浪博客文章(通过新浪聚合搜索 API,返回 JSON:标题/作者/时间/摘要/链接)。走公开接口 search.sina.com.cn/api/search,无需登录。结果在 data.list,只保留 url 含 blog.sina.com.cn/s/blog_ 的博客条目。",
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
  "description": "拉取 Bloomberg 某个频道的最新头条列表(标题、摘要、链接、配图)。走 Bloomberg 公开 RSS 源,无需登录、不碰付费墙——只拿头条元数据,不抓正文(正文是付费内容)。section 必须是真实频道 slug:markets/technology/economics/politics/industries/businessweek/bview(本配方拼成 feeds.bloomberg.com/<section>/news.rss)。综合首页是另一个独立源 feeds.bloomberg.com/news.rss(无 section 路径),不能通过本配方的 section 入参得到——section 不要填 news(会拼出不存在的 /news/news.rss)。",
  "inputs": { "section": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://feeds.bloomberg.com/{{section}}/news.rss" },
    { "action": "wait", "loadState": "load" },
    { "action": "evaluate", "as": "items", "fn": "() => { const raw = document.body.innerText || (document.documentElement && document.documentElement.textContent) || ''; if (!/<item[\\s>]/i.test(raw)) throw new Error('Bloomberg RSS 返回内容不含条目(频道名可能不对,section 须是真实 slug:markets/technology/economics/politics/industries/businessweek/bview;不要填 news——综合首页是独立源 feeds.bloomberg.com/news.rss),也可能临时不可用'); const dec = s => String(s || '').replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"').replace(/&#39;/g, \"'\").replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim(); const tag = (block, name) => { const m = block.match(new RegExp('<' + name + '(?:\\\\s[^>]*)?>([\\\\s\\\\S]*?)<\\\\/' + name + '>', 'i')); return m ? dec(m[1]) : ''; }; const out = []; const re = /<item\\b[^>]*>([\\s\\S]*?)<\\/item>/gi; let m; while ((m = re.exec(raw)) && out.length < 20) { const b = m[1]; const title = tag(b, 'title'); const link = tag(b, 'link') || tag(b, 'guid'); if (!title || !link) continue; out.push({ title, summary: tag(b, 'description'), link, pubDate: tag(b, 'pubDate') }); } return out; }" }
  ],
  "output": "{{items}}"
},{
  "id": "books-list",
  "match": ["books.toscrape.com"],
  "description": "列出 books.toscrape.com 某个列表页的书籍(标题/价格/库存)。示例配方,用于验证引擎。",
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
  "description": "拉取某个 Bluesky 账号的最新公开帖子(正文/点赞/转发/回复/时间)。走 AT-proto 公开只读 API,无需登录。输入键 username 填账号 handle,如 bsky.app、jay.bsky.team。",
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
  "description": "用 CoinGecko 公开搜索 API 按关键词搜币/交易所/分类，返回 JSON。读接口而非扒 DOM。",
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
  "description": "用 crates.io 的公开搜索 API 搜 Rust crate,返回 JSON(名称/描述等)。读接口而非扒 DOM。",
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
  "description": "携程目的地/城市/景区/酒店关键词联想搜索(排名/名称/类型/城市/点评分/链接)。走携程公开的联想接口 gaHotelSearchEngine,无需登录;先落到 m.ctrip.com 同源再 POST,规避跨域。",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://m.ctrip.com/" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": "async () => { const body = { keyword: '{{query|js}}', searchType: 'D', platform: 'online', pageID: '102001', head: { Locale: 'zh-CN', LocaleController: 'zh_cn', Currency: 'CNY', PageId: '102001', clientID: 'xdt-recipe', group: 'ctrip', Frontend: { sessionID: 1, pvid: 1 }, HotelExtension: { group: 'CTRIP', WebpSupport: false } } }; const r = await fetch('https://m.ctrip.com/restapi/soa2/21881/json/gaHotelSearchEngine', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('携程返回非 JSON(被风控挡),请在持久浏览器里正常访问 ctrip.com 后重试'); } const list = (d && d.Response && Array.isArray(d.Response.searchResults)) ? d.Response.searchResults : []; return list.slice(0, 15).map((it, i) => ({ rank: i + 1, name: String(it.displayName || it.word || it.cityName || '').replace(/\\s+/g, ' ').trim(), type: String(it.displayType || it.type || '').trim(), city: it.cityName || '', score: it.commentScore || it.cStar || '', country: it.countryName || '' })).filter(x => x.name); }"
    }
  ],
  "output": "{{items}}"
},{
  "id": "devto-articles",
  "match": ["dev.to"],
  "description": "用 dev.to 公开 Articles API 按 tag 拉最新文章列表，返回 JSON 数组。读接口而非扒 DOM。",
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
  "description": "用 MDN 的公开搜索 API 搜文档,返回 JSON(标题/slug 等)。读接口而非扒 DOM。",
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
  "description": "搜索豆瓣电影/图书/音乐条目。type 取 movie/book/music。搜索页是客户端渲染,用 evaluate 轮询 .item-root 出现后再扒卡片(标题/评分/简介/链接)。",
  "inputs": { "type": { "required": true }, "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://search.douban.com/{{type}}/subject_search?search_text={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": "async () => { const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const norm=v=>(v||'').replace(/\\s+/g,' ').trim(); for(let i=0;i<20;i++){ if(document.querySelector('.item-root .title-text, .item-root .title a')) break; await sleep(300); } const out=[]; const seen=new Set(); for(const el of document.querySelectorAll('.item-root')){ const t=el.querySelector('.title-text, .title a, a[title]'); const title=norm(t&&t.textContent)||norm(t&&t.getAttribute('title')); let url=(t&&t.getAttribute('href'))||''; if(!title||!url||url.indexOf('/subject/')<0||seen.has(url)) continue; seen.add(url); const rating=norm((el.querySelector('.rating_nums')||{}).textContent); const abs=norm((el.querySelector('.meta.abstract, .meta, .abstract, p')||{}).textContent); out.push({ rank: out.length+1, title: title, rating: rating, abstract: abs.slice(0,100), url: url }); if(out.length>=20) break; } if(!out.length){ const bodyText=document.body&&document.body.innerText||''; if(/验证|安全/.test(bodyText)) throw new Error('豆瓣触发风控验证,请在持久浏览器里手动通过验证/登录后重试'); if(!/没有找到|没有符合|暂无|无结果|找不到|沒有找到/.test(bodyText)) throw new Error('豆瓣搜索未扒到任何条目,且页面未出现\"没有找到\"等空结果标识(多半是页面未渲染完/结构变化/被风控),请在持久浏览器里正常访问 search.douban.com 后重试,或改用其它方式'); } return out; }"
    }
  ],
  "output": "{{items}}"
},{
  "id": "douyin-user-videos",
  "match": ["douyin.com"],
  "description": "读取某抖音用户的公开作品列表(标题/点赞数/时长/视频地址)。先落到 douyin.com 域,再在页面内同源 fetch JSON——带上 cookie 由浏览器签名,规避风控(直接 navigate 到 api 会被喂 SPA HTML 或风控)。输入键 sec_uid 是用户主页 URL https://www.douyin.com/user/<sec_uid> 末段那串长字符。",
  "inputs": { "sec_uid": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.douyin.com/user/{{sec_uid}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "videos",
      "fn": "async () => { const r = await fetch('https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=' + encodeURIComponent('{{sec_uid|js}}') + '&max_cursor=0&count=20&aid=6383', { credentials: 'include', headers: { referer: 'https://www.douyin.com/' } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('抖音返回非 JSON(未登录或被风控),请在持久浏览器登录 douyin.com 后重试'); } if (d && d.status_code && d.status_code !== 0) throw new Error('抖音接口返回异常 status_code=' + d.status_code + '(可能被风控),请在持久浏览器登录 douyin.com 后重试'); const list = (d && d.aweme_list) ? d.aweme_list : []; return list.map((v, i) => ({ index: i + 1, aweme_id: v.aweme_id, title: v.desc || '', duration: v.video && v.video.duration ? Math.round(v.video.duration / 1000) : 0, digg: v.statistics && v.statistics.digg_count || 0, play_url: v.video && v.video.play_addr && v.video.play_addr.url_list && v.video.play_addr.url_list[0] || '' })); }"
    }
  ],
  "output": "{{videos}}"
},{
  "id": "facebook-search",
  "match": ["facebook.com"],
  "description": "在 Facebook 搜索人/主页/帖子,返回粗粒度结果(标题/摘要/链接)。无公开 API,扒渲染后的 React DOM(role=article)。需登录态。",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.facebook.com" },
    { "action": "navigate", "url": "https://www.facebook.com/search/top?q={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": "async () => { const sleep=ms=>new Promise(r=>setTimeout(r,ms)); await sleep(4000); const body=document.body&&document.body.innerText||''; if(/log in|Log In|登录|你需要先登录/.test(body) && !document.querySelector('[role=\"article\"]')) throw new Error('Facebook 需登录,请在持久浏览器登录后重试'); let items=document.querySelectorAll('[role=\"article\"]'); if(!items.length) items=document.querySelectorAll('[role=\"listitem\"]'); return Array.from(items).filter(el=>el.textContent.trim().length>20).slice(0,15).map((el,i)=>{ const link=el.querySelector('a[href*=\"facebook.com/\"]'); const h=el.querySelector('h2, h3, h4, strong'); return { rank: i+1, title: h?h.textContent.trim().slice(0,80):'', text: el.textContent.trim().replace(/\\s+/g,' ').slice(0,150), url: link?link.href.split('?')[0]:'' }; }); }"
    }
  ],
  "output": "{{items}}"
},{
  "id": "sinafinance-news",
  "match": ["finance.sina.com.cn", "app.cj.sina.com.cn"],
  "description": "读取新浪财经 7x24 小时实时财经快讯(返回 JSON:id/发布时间/正文/阅读数)。走公开接口 app.cj.sina.com.cn/api/news/pc,无需登录。limit 控制条数(最大 50),tag=0 为全部。",
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
  "description": "查询某只股票/ETF/指数的实时行情(价格、涨跌、当日高低、成交量、52周高低、货币与交易所)。走 Yahoo 公开的 v8 chart JSON 接口,无需登录;接口主机是纯 JSON 域,直接 navigate 取数即可。symbol 用交易代码(如 AAPL、MSFT、^GSPC、BTC-USD)。",
  "inputs": { "symbol": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://query1.finance.yahoo.com/v8/finance/chart/{{symbol}}?interval=1d&range=1d" },
    { "action": "wait", "loadState": "load" },
    { "action": "evaluate", "as": "quote", "fn": "() => { const raw = document.body.innerText || ''; let d; try { d = JSON.parse(raw); } catch(e) { throw new Error('Yahoo 行情接口返回非 JSON(可能被风控或接口变更),请稍后重试或换 query2.finance.yahoo.com'); } const c = d && d.chart && d.chart.result && d.chart.result[0]; if (!c) { const err = d && d.chart && d.chart.error; throw new Error('未取到行情' + (err ? (': ' + (err.description || err.code)) : '(代码可能不存在)')); } const m = c.meta || {}; const prev = m.previousClose != null ? m.previousClose : m.chartPreviousClose; const price = m.regularMarketPrice; const change = (price != null && prev != null) ? (price - prev) : null; const pct = (change != null && prev) ? ((change / prev) * 100) : null; return { symbol: m.symbol, name: m.shortName || m.longName || m.symbol, price: price, change: change != null ? Number(change.toFixed(2)) : null, changePercent: pct != null ? Number(pct.toFixed(2)) : null, previousClose: prev, dayHigh: m.regularMarketDayHigh, dayLow: m.regularMarketDayLow, volume: m.regularMarketVolume, fiftyTwoWeekHigh: m.fiftyTwoWeekHigh, fiftyTwoWeekLow: m.fiftyTwoWeekLow, currency: m.currency, exchange: m.fullExchangeName || m.exchangeName }; }" }
  ],
  "output": "{{quote}}"
},{
  "id": "hf-model-search",
  "match": ["huggingface.co"],
  "description": "用 Hugging Face 公开 API 搜索模型,返回 JSON 数组(模型 id/下载量/likes)。读接口而非扒页面。",
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
  "description": "在 IMDb 按关键词搜电影/剧集/人物,返回匹配列表(标题、年份、类型、IMDb id、详情页 URL)。IMDb 搜索页内容只读无需登录,但数据藏在页面的 Next.js 数据块里(直接拿接口会被反爬),所以先 navigate 到搜索页再在页面内解析。query 是搜索词(片名/人名)。",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.imdb.com/find/?q={{query|url}}&ref_=nv_sr_sm&language=en-US" },
    { "action": "wait", "loadState": "load" },
    { "action": "evaluate", "as": "results", "fn": "async () => { const deadline = Date.now() + 12000; const read = () => { const el = document.getElementById('__NEXT_DATA__'); if (!el) return null; let nd; try { nd = JSON.parse(el.textContent || 'null'); } catch(e) { return null; } const pp = nd && nd.props && nd.props.pageProps; if (!pp) return null; const out = []; const titles = (pp.titleResults && pp.titleResults.results) || []; for (const tr of titles) { const it = tr.listItem || {}; const tt = (it.titleText && (it.titleText.text || it.titleText)) || (it.originalTitleText && (it.originalTitleText.text || it.originalTitleText)) || ''; let yr = ''; if (it.releaseYear != null) yr = String(typeof it.releaseYear === 'object' ? (it.releaseYear.year || '') : it.releaseYear); const ty = (it.titleType && (it.titleType.text || it.titleType.id)) || it.titleType || 'title'; out.push({ id: tr.index || '', kind: 'title', title: tt, year: yr, type: ty, url: tr.index ? ('https://www.imdb.com/title/' + tr.index + '/') : '' }); } const names = (pp.nameResults && pp.nameResults.results) || []; for (const nr of names) { const it = nr.listItem || {}; const nm = (it.nameText && (it.nameText.text || it.nameText)) || ''; out.push({ id: nr.index || '', kind: 'name', title: nm, year: '', type: 'Person', url: nr.index ? ('https://www.imdb.com/name/' + nr.index + '/') : '' }); } return out; }; let r = read(); while ((!r || r.length === 0) && Date.now() < deadline) { await new Promise(res => setTimeout(res, 250)); r = read(); } if (r == null) throw new Error('未能解析 IMDb 搜索结果(页面结构可能变更或被反爬拦截),请重试'); return r.slice(0, 25); }" }
  ],
  "output": "{{results}}"
},{
  "id": "instagram-profile",
  "match": ["instagram.com"],
  "description": "读取某个 Instagram 账号的公开资料(用户名/昵称/粉丝数/关注数/发帖数/是否认证/简介)。先落到 instagram.com 域,再在页面内带登录 cookie 同源 fetch 内部 web_profile_info 接口——需要在持久浏览器里已登录 Instagram。",
  "inputs": { "username": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.instagram.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "profile",
      "fn": "async () => { const r = await fetch('https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent('{{username|js}}'), { credentials: 'include', headers: { 'X-IG-App-ID': '936619743392459' } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Instagram 返回非 JSON(未登录或被风控),请在持久浏览器里登录 Instagram 后重试'); } const u = d && d.data && d.data.user; if (!u) throw new Error('未找到用户: {{username|js}}'); return { username: u.username, name: u.full_name || '', followers: (u.edge_followed_by && u.edge_followed_by.count) || 0, following: (u.edge_follow && u.edge_follow.count) || 0, posts: (u.edge_owner_to_timeline_media && u.edge_owner_to_timeline_media.count) || 0, verified: !!u.is_verified, private: !!u.is_private, bio: (u.biography || '').replace(/\\n/g, ' ').slice(0, 200), userId: u.id, url: 'https://www.instagram.com/' + u.username }; }"
    }
  ],
  "output": "{{profile}}"
},{
  "id": "jd-item",
  "match": ["jd.com"],
  "description": "读取京东某个商品的详情(标题、价格、店铺、规格参数、商品主图)。京东商品页要登录态才完整展示、且价格/详情图是滚动懒加载的,所以先 navigate 到商品页、滚动触发加载,再在页面内抓 DOM。sku 是商品 SKU id(商品 URL item.jd.com/<sku>.html 里的数字)。需要先在持久浏览器登录京东。",
  "inputs": { "sku": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://item.jd.com/{{sku}}.html" },
    { "action": "wait", "loadState": "load" },
    { "action": "evaluate", "as": "scroll", "fn": "async () => { for (let i = 1; i <= 6; i++) { window.scrollTo(0, i * 2500); await new Promise(r => setTimeout(r, 700)); } window.scrollTo(0, document.body.scrollHeight); await new Promise(r => setTimeout(r, 1200)); return true; }" },
    { "action": "evaluate", "as": "item", "fn": "() => { const m = location.pathname.match(/(\\d+)\\.html/); const sku = m ? m[1] : ''; const txt = el => (el && el.textContent ? el.textContent.trim() : ''); const priceEl = document.querySelector('.J-p-' + sku) || document.querySelector('.p-price strong') || document.querySelector('[class*=\"price\"] [class*=\"num\"]'); const price = txt(priceEl) || '未获取到价格(可能需登录或未触发加载)'; const title = txt(document.querySelector('.sku-name')) || txt(document.querySelector('.product-title')) || (document.title.split('-')[0] || '').trim(); const shop = txt(document.querySelector('.J-shop-name')) || txt(document.querySelector('[class*=\"shop\"] a')) || '京东自营'; const imgs = Array.from(document.querySelectorAll('img[src*=\"360buyimg.com\"]')).map(im => im.src).filter(Boolean); const images = [...new Set(imgs)].slice(0, 10); const specs = {}; const text = document.body.innerText || ''; const sm = text.match(/商品编号[\\s\\S]*?(?=包装清单|售后保障|$)/); if (sm) { const lines = sm[0].split('\\n').map(l => l.trim()).filter(Boolean); for (let i = 0; i < lines.length - 1; i += 2) { const k = lines[i]; const v = lines[i + 1]; if (k && v && k !== '商品编号') specs[k] = v; } } return { sku, title, price, shop, specs, images, totalImages: [...new Set(imgs)].length }; }" }
  ],
  "output": "{{item}}"
},{
  "id": "linkedin-jobs-search",
  "match": ["linkedin.com"],
  "description": "搜索 LinkedIn 职位(标题/链接)。走 Voyager 内部 API:页面内同源 fetch,csrf-token 取自 JSESSIONID cookie。需登录态。⚠️ LinkedIn 对自动化封号较狠,谨慎用。",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.linkedin.com/feed/" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "jobs",
      "fn": "async () => { const js=document.cookie.split(';').map(p=>p.trim()).find(p=>p.indexOf('JSESSIONID=')===0); if(!js) throw new Error('未找到 JSESSIONID,请先在持久浏览器登录 LinkedIn'); const csrf=js.slice('JSESSIONID='.length).replace(/^\"|\"$/g,''); const q=encodeURIComponent('{{query|js}}'); const query='(origin:JOB_SEARCH_PAGE_OTHER_ENTRY,keywords:'+q+',spellCorrectionEnabled:true)'; const url='/voyager/api/voyagerJobsDashJobCards?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220&count=25&q=jobSearch&query='+query+'&start=0'; const res=await fetch(url,{credentials:'include',headers:{'csrf-token':csrf,'x-restli-protocol-version':'2.0.0'}}); const t=await res.text(); let d; try{ d=JSON.parse(t); }catch(e){ throw new Error('LinkedIn 返回非 JSON(未登录或被风控),请在持久浏览器登录后重试'); } const els=Array.isArray(d&&d.elements)?d.elements:[]; return els.map(el=>{ const card=el&&el.jobCardUnion&&el.jobCardUnion.jobPostingCard; if(!card) return null; const urn=String(card.jobPostingUrn||(card.jobPosting&&card.jobPosting.entityUrn)||card.entityUrn||''); const m=urn.match(/(\\d+)/); const id=m?m[1]:''; return { title: card.jobPostingTitle||(card.title&&card.title.text)||'', url: id?'https://www.linkedin.com/jobs/view/'+id:'' }; }).filter(Boolean); }"
    }
  ],
  "output": "{{jobs}}"
},{
  "id": "linuxdo-latest",
  "match": ["linux.do"],
  "description": "读取 linux.do(Discourse 论坛)最新话题列表(标题/回复数/点赞/浏览/链接)。先落到 linux.do 域,再在页面内同源 fetch /latest.json——公开内容免登录即可读,登录态会带上 cookie 并规避 Cloudflare 拦截。",
  "inputs": {},
  "steps": [
    { "action": "navigate", "url": "https://linux.do" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "topics",
      "fn": "async () => { const r = await fetch('/latest.json', { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('linux.do 返回非 JSON(被 Cloudflare 拦或需登录),请在持久浏览器里正常访问/登录该站后重试'); } const list = (d && d.topic_list && d.topic_list.topics) ? d.topic_list.topics : []; return list.map(x => ({ title: x.fancy_title || x.title, replies: Math.max(0, (x.posts_count || 1) - 1), likes: x.like_count || 0, views: x.views || 0, created: x.created_at, url: 'https://linux.do/t/topic/' + x.id })); }"
    }
  ],
  "output": "{{topics}}"
},{
  "id": "lobsters-feed",
  "match": ["lobste.rs"],
  "description": "拉取 lobste.rs 某个 feed 的故事列表(JSON)。feed 取 hottest/newest/active。lobste.rs 没有可用的 search.json,列表端点才是稳定的读接口。",
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
  "description": "读取即刻某用户的动态列表(正文/类型/点赞/评论/时间/链接)。即刻移动站(m.okjike.com)是 Next.js SSR,帖子数据内嵌在页面的 <script type=\"application/json\"> 里,navigate 后直接解析该 JSON,无需调接口、公开主页免登录可读。",
  "inputs": { "username": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://m.okjike.com/users/{{username}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "posts",
      "fn": "async () => { const el = document.getElementById('__NEXT_DATA__') || document.querySelector('script#__NEXT_DATA__[type=\"application/json\"]') || document.querySelector('script[type=\"application/json\"]'); if (!el) throw new Error('未找到即刻 SSR 数据(页面结构变化或该用户不存在/需登录),请确认用户名或在持久浏览器登录后重试'); let data; try { data = JSON.parse(el.textContent); } catch (e) { throw new Error('即刻 SSR JSON 解析失败'); } const posts = (data && data.props && data.props.pageProps && data.props.pageProps.posts) ? data.props.pageProps.posts : []; return posts.map(p => ({ content: (p.content || '').replace(/\\n/g, ' ').slice(0, 200), type: p.type === 'ORIGINAL_POST' ? 'post' : p.type === 'REPOST' ? 'repost' : (p.type || ''), likes: p.likeCount || 0, comments: p.commentCount || 0, time: p.actionTime || p.createdAt || '', url: p.id ? 'https://web.okjike.com/originalPost/' + p.id : '' })); }"
    }
  ],
  "output": "{{posts}}"
},{
  "id": "medium-tag-feed",
  "match": ["medium.com"],
  "description": "按话题标签拉取 Medium 最新文章(标题/作者/链接/发布时间/摘要)。走 Medium 公开 RSS feed,无需登录;在页面内 fetch RSS 文本并用 DOMParser 解析成结构化 JSON。tag 用话题英文 slug,如 technology、programming、artificial-intelligence。",
  "inputs": { "tag": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://medium.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "articles",
      "fn": "async () => { const r = await fetch('https://medium.com/feed/tag/' + encodeURIComponent('{{tag|js}}')); const t = await r.text(); if (!t || t.indexOf('<rss') === -1 && t.indexOf('<item') === -1) throw new Error('Medium RSS 返回异常(标签不存在或被风控),请确认 tag slug 正确后重试'); const doc = new DOMParser().parseFromString(t, 'text/xml'); const items = Array.from(doc.querySelectorAll('item')); const txt = (el, sel) => { const n = el.querySelector(sel); return n ? (n.textContent || '').trim() : ''; }; const strip = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim(); return items.map((it, i) => ({ rank: i + 1, title: txt(it, 'title'), author: (it.getElementsByTagName('dc:creator')[0] || {}).textContent || '', link: (txt(it, 'link') || txt(it, 'guid')).split('?')[0], published: txt(it, 'pubDate'), summary: strip(txt(it, 'description')).slice(0, 200) })); }"
    }
  ],
  "output": "{{articles}}"
},{
  "id": "wechat-article",
  "match": ["mp.weixin.qq.com"],
  "description": "读取一篇微信公众号文章:标题/公众号名/作者/发布时间/正文全文/正文图片地址。无需登录,url 传文章分享链接(https://mp.weixin.qq.com/s/... 或 /s?__biz=... 形式)。注意:没有免登录的搜索/列表接口,文章链接需由用户提供。",
  "inputs": { "url": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "{{url}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "article",
      "fn": "() => { if (location.hostname !== 'mp.weixin.qq.com') { throw new Error('当前页面不是微信公众号文章(host: ' + location.hostname + '),url 必须是 https://mp.weixin.qq.com/s/... 链接'); } const q = (s) => { const el = document.querySelector(s); return el ? el.textContent.trim() : ''; }; const content = document.querySelector('#js_content'); if (!content) { throw new Error('页面没有正文容器 #js_content(链接可能已过期、文章被删除/屏蔽,或被环境验证页拦截)。页面开头:' + (document.body.innerText || '').slice(0, 120)); } const images = Array.from(content.querySelectorAll('img')).map(im => im.getAttribute('data-src') || im.getAttribute('src') || '').filter(u => u.indexOf('http') === 0); const full = content.innerText.trim(); const MAX = 40000; return { title: q('#activity-name') || document.title, account: q('#js_name'), author: q('#js_author_name'), publishTime: q('#publish_time'), text: full.slice(0, MAX), truncated: full.length > MAX, images }; }"
    }
  ],
  "output": "{{article}}"
},{
  "id": "hn-search",
  "match": ["news.ycombinator.com", "hn.algolia.com"],
  "description": "用 Hacker News 的公开 Algolia 搜索 API 搜故事,返回 JSON(标题/链接/作者/分数)。读接口而非扒 DOM。",
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
  "description": "用 npm registry 的公开搜索 API 搜包,返回 JSON(包名/版本/描述)。读接口而非扒 DOM。",
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
  "description": "在 Pixiv 按关键词/标签搜索插画(标题/作者/作品id/页数/收藏数/标签/链接)。先落到 pixiv.net 域,再在页面内同源 fetch Ajax 搜索接口(带登录 cookie)。Pixiv 搜索接口需要登录,未登录会抛错提示。query 是搜索关键词或标签。",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.pixiv.net" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "illusts",
      "fn": "async () => { const w = encodeURIComponent('{{query|js}}'); const r = await fetch('/ajax/search/illustrations/' + w + '?word=' + w + '&order=date_d&mode=all&p=1&s_mode=s_tag_full&type=illust_and_ugoira', { credentials: 'include' }); if (r.status === 401 || r.status === 403) throw new Error('Pixiv 需要登录,请在持久浏览器里登录 pixiv.net 后重试'); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Pixiv 返回非 JSON(未登录或被风控),请在持久浏览器里登录 pixiv.net 后重试'); } const arr = (d && d.body && d.body.illust && Array.isArray(d.body.illust.data)) ? d.body.illust.data : []; return arr.filter(x => x.id).map(x => ({ title: x.title || '', author: x.userName || '', illust_id: x.id, pages: x.pageCount || 1, bookmarks: x.bookmarkCount || 0, tags: (x.tags || []).slice(0, 5).join(', '), url: 'https://www.pixiv.net/artworks/' + x.id })); }"
    }
  ],
  "output": "{{illusts}}"
},{
  "id": "producthunt-feed",
  "match": ["producthunt.com", "www.producthunt.com"],
  "description": "读取 Product Hunt 最新发布的产品列表(名称/一句话简介/作者/发布时间/链接)。走官方公开 Atom feed,无需登录。返回的是 Atom XML 文本,每条产品在 <entry> 里:<title> 产品名、<content> 含 tagline、<author><name> 作者、<published> 时间、<link href> 产品页。",
  "steps": [
    { "action": "navigate", "url": "https://www.producthunt.com/feed" },
    { "action": "wait", "loadState": "load" },
    { "action": "extract", "as": "xml", "extract": { "fields": { "body": "body" } } }
  ],
  "output": "{{xml}}"
},{
  "id": "pubmed-search",
  "match": ["pubmed.ncbi.nlm.nih.gov", "eutils.ncbi.nlm.nih.gov"],
  "description": "用 NCBI E-utilities esearch 在 PubMed 按关键词搜文献，返回匹配的 PMID 列表 JSON。读接口而非扒 DOM。",
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
  "description": "查询某个 PyPI 包的公开信息 API,返回 JSON(包名/版本/摘要/发布等)。读接口而非扒 DOM。",
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
  "description": "读取某个 subreddit 的热门帖子列表(标题/版块/分数/评论数/作者/链接)。先落到 reddit.com 域,再在页面内同源 fetch JSON——这样带上登录 cookie、不被反爬挡(直接 navigate 到 .json 会被喂 SPA HTML)。",
  "inputs": { "subreddit": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.reddit.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "posts",
      "fn": "async () => { const r = await fetch('/r/{{subreddit|js}}/hot.json?limit=25&raw_json=1', { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('reddit 返回非 JSON(被反爬挡或未登录),请在持久浏览器里正常访问/登录该站后重试'); } return (d && d.data && d.data.children ? d.data.children : []).map(c => ({ title: c.data.title, subreddit: c.data.subreddit_name_prefixed, score: c.data.score, comments: c.data.num_comments, author: c.data.author, url: 'https://www.reddit.com' + c.data.permalink })); }"
    }
  ],
  "output": "{{posts}}"
},{
  "id": "reuters-search",
  "match": ["reuters.com", "www.reuters.com"],
  "description": "按关键词搜索路透社(Reuters)新闻(标题/日期/板块/链接)。先落到 reuters.com 域,再在页面内同源 fetch 站内搜索 JSON 接口——带 cookie + 正确 headers、绕过反爬。query 是搜索关键词。Reuters 有较强风控,未登录或被挡时会抛错提示。",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.reuters.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "articles",
      "fn": "async () => { const q = JSON.stringify({ keyword: '{{query|js}}', offset: 0, orderby: 'display_date:desc', size: 20, website: 'reuters' }); const r = await fetch('/pf/api/v3/content/fetch/articles-by-search-v2?query=' + encodeURIComponent(q), { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Reuters 返回非 JSON(被反爬挡或区域限制),请在持久浏览器里正常访问 reuters.com 后重试'); } const arr = (d && d.result && Array.isArray(d.result.articles)) ? d.result.articles : []; return arr.map(a => ({ title: a.title || (a.headlines && a.headlines.basic) || '', date: (a.display_date || a.published_time || '').split('T')[0], section: (a.taxonomy && a.taxonomy.section && a.taxonomy.section.name) || '', url: a.canonical_url ? 'https://www.reuters.com' + a.canonical_url : '' })); }"
    }
  ],
  "output": "{{articles}}"
},{
  "id": "hockey-search",
  "match": ["scrapethissite.com"],
  "description": "在 scrapethissite forms 页搜索球队并抽取结果(演示交互步:输入+回车提交)。示例配方。",
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
  "description": "在什么值得买搜索好价/商品(返回标题/价格/商城/评论数/链接)。无干净 JSON 接口,直接 navigate 到搜索结果页再从 DOM 抓取;建议用持久浏览器(带登录态结果更全、更少风控)。",
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
  "description": "用 Stack Exchange 公开 API 按相关度搜 Stack Overflow 问题,返回 JSON(标题/链接/分数)。读接口而非扒页面。",
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
  "description": "按关键词搜索 Steam 商店里的游戏/应用(名称/AppID/价格/平台/Metacritic 评分/详情页链接)。走 Steam 公开商店搜索接口 storesearch,无需登录;价格字段是货币最小单位整数(如 999=$9.99)。",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://store.steampowered.com/" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": "async () => { const r = await fetch('/api/storesearch/?cc=us&l=english&term=' + encodeURIComponent('{{query|js}}'), { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Steam 返回非 JSON(被风控挡),请稍后重试或在持久浏览器里正常访问 store.steampowered.com'); } return (d && d.items ? d.items : []).map(g => ({ appid: g.id, name: g.name, type: g.type, price: g.price ? g.price.final : null, currency: g.price ? g.price.currency : '', metascore: g.metascore || '', platforms: g.platforms ? Object.keys(g.platforms).filter(k => g.platforms[k]).join(',') : '', url: g.id ? 'https://store.steampowered.com/app/' + g.id : '' })); }"
    }
  ],
  "output": "{{items}}"
},{
  "id": "substack-search",
  "match": ["substack.com"],
  "description": "按关键词搜索 Substack 文章(标题/作者/日期/摘要/链接)。先落到 substack.com 域,再在页面内同源 fetch 官方搜索 JSON 接口——同源调用带正确 headers、不被风控挡(直接 navigate 到 api 路径会被喂 SPA HTML)。无需登录。query 是搜索关键词。",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://substack.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "posts",
      "fn": "async () => { const r = await fetch('/api/v1/post/search?query=' + encodeURIComponent('{{query|js}}') + '&page=0&includePlatformResults=true', { credentials: 'include', headers: { Accept: 'application/json' } }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Substack 返回非 JSON(被风控挡或接口变动),请在持久浏览器里正常访问 substack.com 后重试'); } return (d && Array.isArray(d.results) ? d.results : []).map(x => ({ title: x.title, author: (x.publishedBylines && x.publishedBylines[0] && x.publishedBylines[0].name) || '', date: (x.post_date || '').split('T')[0], description: (x.description || x.subtitle || x.truncated_body_text || '').slice(0, 200), url: x.canonical_url })); }"
    }
  ],
  "output": "{{posts}}"
},{
  "id": "tieba-hot-topics",
  "match": ["tieba.baidu.com"],
  "description": "读取百度贴吧热议话题榜(标题/讨论量/简介/链接)。贴吧热榜页是服务端渲染的列表,navigate 后直接用 extract 按选择器抓 li.topic-top-item,无需登录、无需调接口。",
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
  "description": "读取 V2EX 当前热门主题(标题/节点/回复数/链接),走官方公开 API,无需登录;直接 navigate 到 JSON 端点即可拿到原始 JSON。",
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
  "description": "读取微博热搜榜(排名/热词/热度值/分类/标签/链接)。先落到 weibo.com 域,再在页面内同源 fetch JSON——带上登录 cookie、不被风控挡(直接 navigate 到 ajax 接口会被喂 SPA HTML)。",
  "inputs": { "limit": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://weibo.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": "async () => { const limit = Number('{{limit|js}}') || 30; const r = await fetch('/ajax/statuses/hot_band', { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('微博返回非 JSON(未登录或被风控),请在持久浏览器登录 weibo.com 后重试'); } if (!d || !d.ok) throw new Error('微博热搜接口返回异常(可能未登录),请在持久浏览器登录 weibo.com 后重试'); const list = (d.data && d.data.band_list) ? d.data.band_list : []; return list.slice(0, limit).map((b, i) => ({ rank: b.realpos || (i + 1), word: b.word, hot: b.num || 0, category: b.category || '', label: b.label_name || '', url: 'https://s.weibo.com/weibo?q=' + encodeURIComponent('#' + b.word + '#') })); }"
    }
  ],
  "output": "{{items}}"
},{
  "id": "weread-search",
  "match": ["weread.qq.com"],
  "description": "在微信读书按关键词搜索图书,返回书名/作者/书籍 ID 列表。走公开 Web 搜索接口 /web/search/global,无需登录。结果在 books 数组,每项的 bookInfo.bookId 可用于后续看书详情。",
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
  "description": "用 Wikipedia 公开 MediaWiki API 搜索条目,返回 JSON(标题/摘要片段)。读接口而非扒页面。",
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
  "description": "搜索 Coupang(韩国电商)商品(排名/标题/商品ID/价格/原价/评分/评价数/商品页链接)。先落到 coupang.com 域,再在页面内同源 fetch 搜索 JSON——带上登录 cookie、不被风控挡(Coupang 反爬严,未登录/被挡时返回 HTML 而非 JSON)。",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.coupang.com/np/search?channel=user&page=1&q={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": "async () => { const num = v => { const s = (v == null ? '' : String(v)).replace(/[^\\d.]/g, ''); const n = Number(s); return s && Number.isFinite(n) ? n : null; }; const r = await fetch('/np/search?q=' + encodeURIComponent('{{query|js}}') + '&channel=user&page=1', { credentials: 'include' }); const t = await r.text(); if (t.trim().startsWith('<')) throw new Error('Coupang 返回 HTML 而非 JSON(未登录或被反爬挡),请在持久浏览器登录 coupang.com 后重试'); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('Coupang 返回非 JSON(被反爬挡),请在持久浏览器登录 coupang.com 后重试'); } const list = d.data && (d.data.products || d.data.productList) || d.products || d.productList || d.items || []; return (Array.isArray(list) ? list : []).slice(0, 20).map((p, i) => { const pid = String(p.productId || p.product_id || p.id || p.productNo || '').match(/(\\d{6,})/); const id = pid ? pid[1] : ''; return { rank: i + 1, title: p.title || p.name || p.productName || '', productId: id, price: num(p.price || p.salePrice || p.finalPrice || p.sellingPrice), originalPrice: num(p.originalPrice || p.basePrice || p.listPrice), rating: num(p.rating || p.star || p.reviewRating), reviewCount: num(p.reviewCount || p.ratingCount || p.reviews), url: id ? 'https://www.coupang.com/vp/products/' + id : '' }; }); }"
    }
  ],
  "output": "{{items}}"
},{
  "id": "xiaoyuzhou-podcast",
  "match": ["xiaoyuzhoufm.com"],
  "description": "查看小宇宙某个播客的资料与最近单集(节目名/作者/简介/订阅数/单集总数 + 内嵌的最近单集列表 eid/标题/时长/播放量/日期)。输入键 podcast_id 填播客 ID(取自 xiaoyuzhoufm.com/podcast/<ID> 的 URL 路径末段)。小宇宙是 Next.js 静态导出站,页面数据落在 __NEXT_DATA__,无需登录。",
  "inputs": { "podcast_id": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.xiaoyuzhoufm.com/podcast/{{podcast_id}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "podcast",
      "fn": "() => { const fmtDur = s => { if (!Number.isFinite(s) || s < 0) return '-'; s = Math.round(s); return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0'); }; const nd = window.__NEXT_DATA__; const pp = nd && nd.props && nd.props.pageProps ? nd.props.pageProps : null; const p = pp && pp.podcast; if (!p) throw new Error('未取到小宇宙播客数据(ID 不存在或页面结构变化),请核对 xiaoyuzhoufm.com/podcast/<ID> 中的 ID'); const eps = Array.isArray(p.episodes) ? p.episodes : []; return { title: p.title, author: p.author, description: p.brief, subscribers: p.subscriptionCount, episodeCount: p.episodeCount, latest: (p.latestEpisodePubDate || '').slice(0,10), episodes: eps.slice(0,15).map(e => ({ eid: e.eid, title: e.title, duration: fmtDur(e.duration), plays: e.playCount, date: (e.pubDate || '').slice(0,10) })) }; }"
    }
  ],
  "output": "{{podcast}}"
},{
  "id": "zsxq-dynamics",
  "match": ["wx.zsxq.com", "zsxq.com"],
  "description": "读取知识星球(zsxq)我加入的所有星球最新动态(时间/星球名/作者/标题/评论数/点赞数/链接)。先落到 wx.zsxq.com 域,再在页面内同源 fetch api.zsxq.com 接口——带上登录 cookie(zsxq 用 httpOnly cookie,必须页面内带凭证发请求)。",
  "inputs": {},
  "steps": [
    { "action": "navigate", "url": "https://wx.zsxq.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "dynamics",
      "fn": "async () => { const r = await fetch('https://api.zsxq.com/v2/dynamics?scope=general&count=20', { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('zsxq 返回非 JSON(未登录或被风控),请在持久浏览器登录知识星球后重试'); } if (d && d.succeeded === false) { throw new Error('zsxq 接口报错(可能未登录): ' + (d.info || d.code)); } const rd = (d && d.resp_data) ? d.resp_data : d; const list = (rd && rd.dynamics) ? rd.dynamics : []; const textOf = (tp) => { if (!tp) return ''; const p = [tp.title, tp.talk && tp.talk.text, tp.question && tp.question.text, tp.answer && tp.answer.text, tp.task && tp.task.text, tp.solution && tp.solution.text].find(v => typeof v === 'string' && v.trim()); return (p || '').replace(/\\s+/g, ' ').trim(); }; const authorOf = (tp) => (tp && (tp.owner && tp.owner.name || tp.talk && tp.talk.owner && tp.talk.owner.name || tp.question && tp.question.owner && tp.question.owner.name || tp.answer && tp.answer.owner && tp.answer.owner.name)) || ''; return list.map(x => { const tp = x.topic; return { time: x.create_time || (tp && tp.create_time) || '', group: (tp && tp.group && tp.group.name) || '', author: authorOf(tp), title: textOf(tp).slice(0, 120), comments: (tp && tp.comments_count) || 0, likes: (tp && tp.likes_count) || 0, url: (tp && tp.topic_id) ? 'https://wx.zsxq.com/topic/' + tp.topic_id : '' }; }); }"
    }
  ],
  "output": "{{dynamics}}"
},{
  "id": "twitter-profile",
  "match": ["x.com", "twitter.com"],
  "description": "读取某个 X(Twitter)账号的资料(昵称/简介/位置/粉丝数/关注数/推文数/是否认证/注册时间)。先落到 x.com 域,再在页面内从 cookie 取 csrf token、带登录态 fetch 内部 GraphQL UserByScreenName 接口——需要在持久浏览器里已登录 x.com。username 不带 @。",
  "inputs": { "username": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://x.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "profile",
      "fn": "async () => { const ct0 = (document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('ct0=')) || '').split('=')[1]; if (!ct0) throw new Error('未登录 x.com(缺 ct0 cookie),请在持久浏览器里登录 X 后重试'); const bearer = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'; const headers = { 'Authorization': 'Bearer ' + decodeURIComponent(bearer), 'X-Csrf-Token': ct0, 'X-Twitter-Auth-Type': 'OAuth2Session', 'X-Twitter-Active-User': 'yes' }; const variables = JSON.stringify({ screen_name: '{{username|js}}'.replace(/^@/, ''), withSafetyModeUserFields: true }); const features = JSON.stringify({ hidden_profile_subscriptions_enabled: true, rweb_tipjar_consumption_enabled: true, responsive_web_graphql_exclude_directive_enabled: true, verified_phone_label_enabled: false, subscriptions_verification_info_is_identity_verified_enabled: true, subscriptions_verification_info_verified_since_enabled: true, highlights_tweets_tab_ui_enabled: true, responsive_web_twitter_article_notes_tab_enabled: true, subscriptions_feature_can_gift_premium: true, creator_subscriptions_tweet_preview_api_enabled: true, responsive_web_graphql_skip_user_profile_image_extensions_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true }); const url = '/i/api/graphql/qRednkZG-rn1P6b48NINmQ/UserByScreenName?variables=' + encodeURIComponent(variables) + '&features=' + encodeURIComponent(features); const r = await fetch(url, { headers: headers, credentials: 'include' }); const txt = await r.text(); let d; try { d = JSON.parse(txt); } catch (e) { throw new Error('x.com 返回非 JSON(未登录、被风控或内部接口已变更),请在持久浏览器登录后重试'); } const res = d && d.data && d.data.user && d.data.user.result; if (!res) throw new Error('未找到用户 @' + '{{username|js}}'.replace(/^@/, '')); const lg = res.legacy || {}; const expanded = lg.entities && lg.entities.url && lg.entities.url.urls && lg.entities.url.urls[0] && lg.entities.url.urls[0].expanded_url; return { screen_name: lg.screen_name || '{{username|js}}'.replace(/^@/, ''), name: lg.name || '', bio: lg.description || '', location: lg.location || '', link: expanded || '', followers: lg.followers_count || 0, following: lg.friends_count || 0, tweets: lg.statuses_count || 0, likes: lg.favourites_count || 0, verified: !!(res.is_blue_verified || lg.verified), created_at: lg.created_at || '', url: 'https://x.com/' + (lg.screen_name || '{{username|js}}'.replace(/^@/, '')) }; }"
    }
  ],
  "output": "{{profile}}"
},{
  "id": "xiaohongshu-search",
  "match": ["xiaohongshu.com"],
  "description": "搜索小红书笔记(标题/作者/点赞/链接)。其内部 API 需 x-s 签名,盲发拿不到;所以走渲染后的 DOM:navigate 搜索页 → 滚动加载 → 扒 section.note-item。需登录态。",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.xiaohongshu.com/search_result?keyword={{query|url}}&source=web_search_result_notes" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": "async () => { const sleep=ms=>new Promise(r=>setTimeout(r,ms)); const norm=v=>(v||'').replace(/\\s+/g,' ').trim(); const abs=h=>!h?'':(h.indexOf('http')===0?h:'https://www.xiaohongshu.com'+h); const body=document.body&&document.body.innerText||''; if(/登录后查看搜索结果|登录|扫码/.test(body) && !document.querySelector('section.note-item')) throw new Error('小红书搜索结果需登录,请在持久浏览器登录后重试'); for(let i=0;i<3;i++){ window.scrollTo(0,document.body.scrollHeight); await sleep(1200); } const out=[]; const seen=new Set(); document.querySelectorAll('section.note-item').forEach(el=>{ if(el.classList.contains('query-note-item')) return; const t=el.querySelector('.title, .note-title, a.title, .footer .title span'); const n=el.querySelector('a.author .name, .name, .author-name, .nick-name, a.author'); const c=el.querySelector('.count, .like-count, .like-wrapper .count'); const linkEl=el.querySelector('a.cover.mask')||el.querySelector('a[href*=\"/search_result/\"]')||el.querySelector('a[href*=\"/explore/\"]')||el.querySelector('a[href*=\"/note/\"]'); const url=abs(linkEl&&linkEl.getAttribute('href')||''); const title=norm(t&&t.textContent); if(!title||!url||seen.has(url)) return; seen.add(url); out.push({ rank: out.length+1, title: title, author: norm(n&&n.textContent), likes: norm(c&&c.textContent), url: url }); }); return out.slice(0,20); }"
    }
  ],
  "output": "{{items}}"
},{
  "id": "xueqiu-search-stock",
  "match": ["xueqiu.com"],
  "description": "在雪球按代码或名称搜股票(返回标准 symbol/名称/交易所/现价/涨跌幅/详情链接)。先落到 xueqiu.com 域,再在页面内同源 fetch JSON——带上登录 cookie、规避风控(直接 navigate 到接口会被喂 SPA HTML 或拦截)。",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://xueqiu.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "stocks",
      "fn": "async () => { const r = await fetch('https://xueqiu.com/stock/search.json?size=10&code=' + encodeURIComponent('{{query|js}}'), { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('雪球返回非 JSON(未登录或被风控),请在持久浏览器登录 xueqiu.com 后重试'); } return (d.stocks || []).map(s => { const ex = s.exchange; let symbol = (ex === 'SH' || ex === 'SZ' || ex === 'BJ') ? (String(s.code).startsWith(ex) ? s.code : ex + s.code) : s.code; return { symbol: symbol, name: s.name, exchange: ex, price: s.current, changePercent: s.percentage != null ? s.percentage.toFixed(2) + '%' : null, url: 'https://xueqiu.com/S/' + symbol }; }); }"
    }
  ],
  "output": "{{stocks}}"
},{
  "id": "youtube-search",
  "match": ["youtube.com", "www.youtube.com"],
  "description": "在 YouTube 按关键词搜视频(标题/频道/播放量/时长/发布时间/链接)。先 navigate 到搜索结果页,YouTube 会把结果写进页面的 window.ytInitialData 引导数据;再 evaluate 从中解析,避免盲扫 DOM。一般无需登录(走持久浏览器会话可拿到个性化结果)。query 是搜索关键词。",
  "inputs": { "query": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.youtube.com/results?search_query={{query|url}}" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "videos",
      "fn": "async () => { const data = window.ytInitialData; if (!data) throw new Error('未拿到 YouTube ytInitialData(页面未加载完或被风控),请在持久浏览器里正常访问 youtube.com 后重试'); const sections = (((((data.contents || {}).twoColumnSearchResultsRenderer || {}).primaryContents || {}).sectionListRenderer || {}).contents) || []; const out = []; for (const sec of sections) { const items = ((sec.itemSectionRenderer || {}).contents) || []; for (const it of items) { const v = it.videoRenderer; if (!v) continue; out.push({ title: (v.title && v.title.runs && v.title.runs[0] && v.title.runs[0].text) || '', channel: (v.ownerText && v.ownerText.runs && v.ownerText.runs[0] && v.ownerText.runs[0].text) || '', views: (v.viewCountText && (v.viewCountText.simpleText || (v.shortViewCountText && v.shortViewCountText.simpleText))) || '', duration: (v.lengthText && v.lengthText.simpleText) || 'LIVE', published: (v.publishedTimeText && v.publishedTimeText.simpleText) || '', url: 'https://www.youtube.com/watch?v=' + v.videoId }); } } return out; }"
    }
  ],
  "output": "{{videos}}"
},{
  "id": "zhihu-search",
  "match": ["zhihu.com"],
  "description": "在知乎按关键词搜索,返回问题/回答/文章(标题/类型/作者/赞同数/链接)。先落到 zhihu.com 域,再在页面内同源 fetch JSON——带上登录 cookie、不被风控挡(直接 navigate 到 api 会被喂 SPA HTML)。",
  "inputs": { "query": { "required": true }, "limit": { "required": true } },
  "steps": [
    { "action": "navigate", "url": "https://www.zhihu.com" },
    { "action": "wait", "loadState": "load" },
    {
      "action": "evaluate",
      "as": "items",
      "fn": "async () => { const strip = (h) => (h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim(); const limit = Number('{{limit|js}}') || 10; const r = await fetch('https://www.zhihu.com/api/v4/search_v3?t=general&offset=0&limit=' + limit + '&q=' + encodeURIComponent('{{query|js}}'), { credentials: 'include' }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch (e) { throw new Error('知乎返回非 JSON(未登录或被风控),请在持久浏览器登录 zhihu.com 后重试'); } return (d && d.data ? d.data : []).filter(it => it.type === 'search_result').map((it, i) => { const o = it.object || {}; const q = o.question || {}; const url = o.type === 'answer' ? 'https://www.zhihu.com/question/' + q.id + '/answer/' + o.id : o.type === 'article' ? 'https://zhuanlan.zhihu.com/p/' + o.id : 'https://www.zhihu.com/question/' + o.id; return { rank: i + 1, title: strip(o.title || q.name || ''), type: o.type, author: (o.author && o.author.name) || '', votes: o.voteup_count || 0, url }; }); }"
    }
  ],
  "output": "{{items}}"
}];

export const BUILTIN_BROWSER_SITE_GUIDES: readonly unknown[] = [{
  "site": "36kr.com",
  "auth": "资讯只读无需登录",
  "entry": {
    "home": "https://www.36kr.com/",
    "rssFeed": "https://www.36kr.com/feed",
    "searchPage": "https://www.36kr.com/search/articles/<keyword>",
    "hotList": "https://www.36kr.com/hot-list/catalog",
    "articlePage": "https://www.36kr.com/p/<articleId>"
  },
  "recipes": ["36kr-news"],
  "notes": "最干净的读接口是 RSS:www.36kr.com/feed,返回标准 RSS XML,无需登录、无需扒 DOM;36kr-news 配方 navigate 到该 URL 再读 body 即拿 XML,逐个 <item> 解析 <title>/<link>(可能是 CDATA)/<pubDate>/<description>(HTML 摘要,需 strip 标签)。其它入口靠前端 SPA 渲染、无干净 JSON:搜索 www.36kr.com/search/articles/<keyword>、热榜 www.36kr.com/hot-list/catalog(还有 renqi 人气/zonghe 综合/shoucang 收藏 三类,后三类 URL 形如 /hot-list/<type>/<YYYY-MM-DD>/1)、文章正文 www.36kr.com/p/<id> —— 这些都要 navigate 后等渲染再用 snapshot/extract 抓 DOM(标题 .article-title/h1,正文 [class*=article-content] p,热榜/搜索取 a[href*='/p/']),稳定性不如 RSS,本配方只收录 RSS 资讯流。"
},{
  "site": "api.fxtwitter.com",
  "auth": "无需登录、无需 API key:FxTwitter(FixTweet)是公开只读 API,读 X(Twitter)公开内容的首选,优先于走 x.com 登录态",
  "entry": {
    "tweet": "https://api.fxtwitter.com/status/<id>",
    "tweetWithUser": "https://api.fxtwitter.com/<screen_name>/status/<id>",
    "userProfile": "https://api.fxtwitter.com/<screen_name>"
  },
  "recipes": ["x-tweet"],
  "notes": "读单条 X 公开推文最省最稳的路径,直接 navigate 到 API URL 再解析 body JSON,不碰 x.com 风控。响应 {code,message,tweet:{text,author:{screen_name,name,followers},replies,retweets,likes,quotes,bookmarks,views,created_at,lang,replying_to,media:{photos[],videos[]},quote}};code 404 = 不存在/已删/私密。x-tweet 配方封装 /status/<id> 并展平常用字段。另有免登录用户资料端点 /<screen_name>(响应 {code,message,user:{screen_name,name,followers,following,tweets,likes,description,joined,...}}),无需配方、照同样姿势 navigate + 解析即可,可替代需登录的 x.com twitter-profile 配方。能力边界:只覆盖单条推文与用户资料;时间线/搜索/回复列表这个 API 做不到——需要登录态走 x.com 内部 GraphQL(见 x.com siteguide)。"
},{
  "site": "arxiv.org",
  "auth": "只读无需登录",
  "entry": {
    "searchApi": "https://export.arxiv.org/api/query?search_query=all:&max_results=20&sortBy=relevance"
  },
  "recipes": ["arxiv-search"],
  "notes": "搜索走公开 arXiv API(https://export.arxiv.org/api/query?search_query=all:&max_results=20&sortBy=relevance),返回 Atom XML(非 JSON):<feed> 下多个 <entry>,每个含 <title>/<summary>/<author><name>/<id>(论文链接)/<published>。直接 navigate 到该 URL 再 extract body 取整段 XML 文本,自行解析 entry。用 https(非 http,避免重定向),search_query 可用 all:/ti:/au:/abs: 等前缀,sortBy 可选 relevance/lastUpdatedDate/submittedDate。"
},{
  "site": "barchart.com",
  "auth": "需要在持久浏览器登录 barchart.com;站内 proxy 接口靠会话 cookie + 页面 CSRF token 鉴权",
  "entry": {
    "quotePage": "https://www.barchart.com/stocks/quotes/<symbol>/overview",
    "optionsPage": "https://www.barchart.com/stocks/quotes/<symbol>/options",
    "unusualActivityPage": "https://www.barchart.com/options/unusual-activity/stocks"
  },
  "recipes": ["barchart-quote"],
  "notes": "关键:Barchart 数据走站内 proxy 接口 /proxies/core-api/v1/...,必须带两样东西——(1) 登录会话 cookie(fetch 时 credentials:'include'),(2) 页面 <meta name=\"csrf-token\"> 的值作为 X-CSRF-TOKEN 请求头。所以不能直接 navigate 到接口 URL,必须先 navigate 到对应 overview/options 页(Angular 注入 csrf-token 可能稍慢,取不到时等几秒重试),再在页面内同源 fetch。直接拿接口或未登录会被喂 SPA HTML / 返回非 JSON。\n常用端点:\n• 行情 GET /proxies/core-api/v1/quotes/get?symbol=<SYM>&fields=symbol,symbolName,lastPrice,priceChange,percentChange,openPrice,highPrice,lowPrice,previousPrice,volume,averageVolume,marketCap,peRatio,earningsPerShare,tradeTime → {data:[{...}]}(barchart-quote 配方已封装,结果直接在 output(已自动解包))。\n• 期权链 GET /proxies/core-api/v1/options/chain?symbol=<SYM>&fields=strikePrice,bidPrice,askPrice,lastPrice,priceChange,volume,openInterest,volatility,delta,gamma,theta,vega,rho,expirationDate,optionType,percentFromLast&raw=1[&expirationDate=YYYY-MM-DD] → {data:[{...}]};按 optionType(call/put)过滤、按 |percentFromLast| 排序取平值附近。\n• 异常期权活跃度 GET /proxies/core-api/v1/options/get?list=options.unusual_activity.stocks.us&fields=baseSymbol,strikePrice,expirationDate,optionType,lastPrice,volume,openInterest,volumeOpenInterestRatio,volatility&orderBy=volumeOpenInterestRatio&orderDir=desc&raw=1&limit=20(盘后该列表可能为空,可回退 list=options.mostActive.us)。\n字段多数已是格式化字符串(如 percentChange='+0.56%'),原始数值可读 row.raw。"
},{
  "site": "bbc.com",
  "auth": "只读无需登录(公开 RSS)",
  "entry": {
    "topNews": "https://feeds.bbci.co.uk/news/rss.xml",
    "world": "https://feeds.bbci.co.uk/news/world/rss.xml",
    "technology": "https://feeds.bbci.co.uk/news/technology/rss.xml",
    "business": "https://feeds.bbci.co.uk/news/business/rss.xml",
    "sport": "https://feeds.bbci.co.uk/sport/rss.xml"
  },
  "recipes": ["bbc-news-feed"],
  "notes": "BBC 的稳定免登录读接口是官方 RSS,host 是 feeds.bbci.co.uk(不是 bbc.com)。bbc-news-feed 配方的 section 入参拼到 https://feeds.bbci.co.uk/{section}/rss.xml:全站头条用 section=news,板块用 news/world、news/technology、news/business、news/health、news/science_and_environment,体育用 sport(或 sport/football 等)。返回是 RSS XML 文本(不是 JSON),每条新闻在 <item> 里:<title> 标题、<description> 摘要、<link> 文章链接、<pubDate> 发布时间、<guid> 唯一 id。需要正文要再 navigate 到 <link>。没有公开搜索 API,只能按板块拉取后本地过滤。"
},{
  "site": "bilibili.com",
  "auth": "热门/排行榜公开内容无需登录即可读;登录态(持久浏览器登录 bilibili.com)可降低风控概率并拿到个性化数据",
  "entry": {
    "home": "https://www.bilibili.com",
    "popular": "https://api.bilibili.com/x/web-interface/popular?pn=1&ps=<limit>",
    "ranking": "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all"
  },
  "recipes": ["bilibili-hot"],
  "notes": "关键:不要直接 navigate 到 api.bilibili.com——非同源访问会被风控喂 SPA HTML/拦截。正确姿势是先 navigate 到 https://www.bilibili.com,再用 evaluate 步在页面内 fetch(api 全路径, {credentials:'include'}):同源 cookie 自动带上。bilibili-hot 走 /x/web-interface/popular?pn=1&ps=<limit>,响应 {data:{list:[{title,owner:{name},stat:{view,danmaku},bvid}]}}。另一个可直接复用的免签名读接口是排行榜 /x/web-interface/ranking/v2?rid=0&type=all(同样 data.list 结构,无需签名,需要时可照 bilibili-hot 套同样的 in-page fetch 模式做成 bilibili-ranking)。视频详情页 URL 用 https://www.bilibili.com/video/<bvid> 拼接。注意:搜索接口 /x/web-interface/wbi/search/type 需要 WBI 动态签名(w_rid + wts,从 nav 接口取 img_key/sub_key 计算),实现脆弱,本配方未收录;若需搜索请走页面交互。务必使用持久浏览器(带登录态)以稳定拿到 JSON。"
},{
  "site": "blog.sina.com.cn",
  "auth": "搜索只读无需登录",
  "entry": {
    "home": "https://blog.sina.com.cn/",
    "searchApi": "https://search.sina.com.cn/api/search?q=<keyword>&tp=mix",
    "userArticleList": "https://blog.sina.com.cn/s/articlelist_<uid>_0_1.html",
    "articlePage": "https://blog.sina.com.cn/s/blog_<id>.html"
  },
  "recipes": ["sinablog-search"],
  "notes": "最干净的读接口是新浪聚合搜索 JSON API:search.sina.com.cn/api/search?q=<keyword>&tp=mix&sort=0&page=1&size=20&from=search_result,无需登录、Node 直连即可;sinablog-search 配方 navigate 到该 URL 再读 body 即拿 JSON {data:{list:[{title(含HTML需strip),media_show/author,time/dataTime,intro/searchSummary,url}]}},筛 url 含 'blog.sina.com.cn/s/blog_' 才是博客正文。其它入口靠 DOM 抓取、稳定性差,本配方不收录:首页热门(blog.sina.com.cn 抓 .day-hot-rank/.hot-rank 里的 a[href*='/s/blog_'])、用户文章列表(blog.sina.com.cn/s/articlelist_<uid>_0_1.html 抓 .articleList .articleCell)、单篇正文(blog.sina.com.cn/s/blog_<id>.html 抓 .articalTitle h2 标题、.articalContent/.blog_content 正文)。如需正文,可 navigate 到具体 blog_<id>.html 后用 extract 抓 .articalContent 文本。"
},{
  "site": "bloomberg.com",
  "auth": "RSS 头条只读无需登录;文章正文是付费墙 + 风控内容,本站不收录正文配方",
  "entry": {
    "rss": "https://feeds.bloomberg.com/<section>/news.rss",
    "rssMain": "https://feeds.bloomberg.com/news.rss"
  },
  "recipes": ["bloomberg-feed"],
  "notes": "只做公开 RSS 头条,不做正文:Bloomberg 文章正文在 www.bloomberg.com 上是付费墙 + 机器人验证(__NEXT_DATA__ 里的 story.body,要有效订阅会话才看得到),不在浏览器配方覆盖范围,故跳过正文抓取。\nRSS 源完全公开、纯 XML,可直接 navigate 后读 document.body.innerText 用正则切 <item>(bloomberg-feed 配方已封装,结果直接在 output(已自动解包),字段 title/summary/link/pubDate)。频道 slug→URL(bloomberg-feed 配方拼 feeds.bloomberg.com/<section>/news.rss):markets→/markets/news.rss、technology→/technology/news.rss、economics→/economics/news.rss、politics→/politics/news.rss、industries→/industries/news.rss、businessweek→/businessweek/news.rss、opinions→/bview/news.rss。综合首页是独立源 https://feeds.bloomberg.com/news.rss(URL 里没有 section 路径段),不能通过 bloomberg-feed 的 section 入参拼出——section 不要填 news(会拼成不存在的 /news/news.rss);要综合首页就直接 navigate 上面这个 rssMain URL。每个 <item> 含 title/description/link/guid/pubDate 及 media:content|media:thumbnail|enclosure 的配图 url。拿到 link 后若需正文,只能靠用户自己的 Bloomberg 订阅会话在浏览器里打开。"
},{
  "site": "books.toscrape.com",
  "auth": "无需登录",
  "entry": { "home": "https://books.toscrape.com/" },
  "pages": [
    {
      "type": "listing",
      "urlPattern": "https://books.toscrape.com/catalogue/page-:n.html",
      "container": "article.product_pod"
    }
  ],
  "recipes": ["books-list"],
  "notes": "静态站。书籍卡片 article.product_pod;标题在 h3 a[title],价格 .price_color,库存 .availability。分页 catalogue/page-N.html。"
},{
  "site": "bsky.app",
  "auth": "只读公开内容无需登录,直接打 AT-proto 公开 API 主机 public.api.bsky.app 即可",
  "entry": {
    "authorFeed": "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=<handle>&limit=25",
    "profile": "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=<handle>",
    "searchActors": "https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=<query>&limit=10"
  },
  "recipes": ["bluesky-user-posts"],
  "notes": "Bluesky 基于开放的 AT-proto,public.api.bsky.app 上的 app.bsky.* XRPC 接口对未登录用户开放,返回标准 JSON,可直接 navigate + extract,不需要 cookie/token。bluesky-user-posts 配方封装的是 getAuthorFeed:返回 {feed:[{post:{record:{text,createdAt},author:{handle,displayName},likeCount,repostCount,replyCount,uri}}],cursor}。其它常用只读端点(同样可直接 navigate 取 JSON):1) 账号资料 getProfile?actor=<handle> 返回 {handle,displayName,followersCount,followsCount,postsCount,description};2) 搜账号 actor.searchActors?q=<query>&limit=10 返回 {actors:[{handle,displayName,description}]}(注意:searchActors 不含 followersCount,要粉丝数得另打 getProfile);3) 粉丝/关注 graph.getFollowers / graph.getFollows?actor=<handle>;4) 帖子线程 feed.getPostThread?uri=<at-uri>&depth=2。注意:帖子全文搜索 feed.searchPosts 需登录态(未登录 403),公开只能按账号取 feed。actor 参数可用 handle 或 did。"
},{
  "site": "coingecko.com",
  "auth": "只读无需登录",
  "entry": { "api": "https://api.coingecko.com/api/v3/search?query={query}" },
  "recipes": ["coingecko-search"],
  "notes": "公开搜索接口。返回 JSON {coins:[{id,name,symbol,market_cap_rank,thumb,...}], exchanges:[...], categories:[...], nfts:[...]}。无需 key（公开 demo 接口有速率限制）。"
},{
  "site": "crates.io",
  "auth": "只读无需登录",
  "entry": {
    "home": "https://crates.io/",
    "searchApi": "https://crates.io/api/v1/crates?q="
  },
  "recipes": ["crates-search"],
  "notes": "搜索走 crates.io 的公开 API(crates.io/api/v1/crates?q=&per_page=20),返回 JSON {crates:[{name,description,max_version,downloads,homepage,repository,...}],meta:{total,...}};直接 navigate 到该 URL 再读 body 即拿到 JSON。"
},{
  "site": "ctrip.com",
  "auth": "公开,无需登录;携程联想搜索接口 gaHotelSearchEngine 对匿名请求开放(用持久浏览器走同源 POST 最稳)",
  "entry": {
    "home": "https://m.ctrip.com/",
    "suggest": "POST https://m.ctrip.com/restapi/soa2/21881/json/gaHotelSearchEngine"
  },
  "recipes": ["ctrip-suggest"],
  "notes": "策略 PUBLIC + 同源 POST。这是个 POST 接口,navigate 只能 GET,所以先 navigate 到 https://m.ctrip.com/ 再用 evaluate 在页面内 fetch POST(同源、避免 CORS;credentials:'include' 顺带带 cookie 但非必需)。请求体核心字段:{keyword:<词>, searchType:'D', platform:'online', pageID:'102001', head:{Locale:'zh-CN', Currency:'CNY', PageId:'102001', clientID:..., group:'ctrip', Frontend:{sessionID:1,pvid:1}, HotelExtension:{group:'CTRIP',WebpSupport:false}}}。响应结构 {Response:{searchResults:[{displayName(展示名), word, cityName, displayType(如「城市」), type(如 City), commentScore(点评分), cStar, countryName}]}}。这是目的地/城市/景区/酒店的联想结果(autocomplete),不含具体可订房单与价格;真要查房价/下单需登录态走更复杂的酒店列表接口,稳定性差,本配方只收录干净的联想读接口。"
},{
  "site": "dev.to",
  "auth": "只读无需登录",
  "entry": { "api": "https://dev.to/api/articles?tag={tag}&per_page=20" },
  "recipes": ["devto-articles"],
  "notes": "公开 Articles 接口。返回 JSON 数组 [{title,url,description,published_at,tag_list,user:{name,username},positive_reactions_count,comments_count,...}]。per_page 控制条数。"
},{
  "site": "developer.mozilla.org",
  "auth": "只读无需登录",
  "entry": {
    "home": "https://developer.mozilla.org/",
    "searchApi": "https://developer.mozilla.org/api/v1/search?q="
  },
  "recipes": ["mdn-search"],
  "notes": "搜索走 MDN 的公开 API(developer.mozilla.org/api/v1/search?q=),返回 JSON {documents:[{title,slug,summary,locale,score,...}],metadata:{total,page,...}};直接 navigate 到该 URL 再读 body 即拿到 JSON。slug 可拼成 https://developer.mozilla.org/<locale>/docs/<slug> 打开文档页。"
},{
  "site": "douban.com",
  "auth": "搜索/榜单多数可匿名,但豆瓣风控较严,登录态(持久浏览器)更稳;触发验证码时需人工通过一次",
  "entry": {
    "search": "https://search.douban.com/{type}/subject_search?search_text={keyword}",
    "movieChart": "https://movie.douban.com/chart",
    "bookChart": "https://book.douban.com/chart"
  },
  "recipes": ["douban-search"],
  "notes": "豆瓣无可用公开 JSON 接口,只能扒服务端+客户端渲染的 DOM。搜索结果页 search.douban.com/{type}/subject_search?search_text= 客户端异步填充,必须先轮询 .item-root 出现再扒(配方已封装)。卡片选择器:标题 .title-text / .title a / a[title];链接取标题 a 的 href(含 /subject/);评分 .rating_nums;简介 .meta.abstract / .meta / .abstract。type ∈ movie/book/music。⚠️ 选择器随豆瓣改版可能失效;失效时配方会快速失败,回退到现场 snapshot+extract,并可 saveRecipe 更新。风控验证码需在持久浏览器里人工通过。"
},{
  "site": "douyin.com",
  "auth": "需要登录态 + 持久浏览器:抖音 web 接口对未登录/非同源会话返回非 JSON 或风控,且依赖浏览器签名(a_bogus)与 cookie,必须在持久浏览器登录 douyin.com 后于页面内 fetch",
  "entry": {
    "home": "https://www.douyin.com/",
    "userPage": "https://www.douyin.com/user/<sec_uid>",
    "userVideosApi": "https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=<sec_uid>&max_cursor=0&count=20&aid=6383",
    "commentsApi": "https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=<aweme_id>&count=10&cursor=0&aid=6383"
  },
  "recipes": ["douyin-user-videos"],
  "notes": "关键:抖音 web 接口的签名(a_bogus)和 cookie 由浏览器自身在页面内发起 fetch 时补齐,所以绝不能直接 navigate 到 api URL(会被喂 SPA HTML 或风控),正确姿势是先 navigate 到目标用户主页 https://www.douyin.com/user/<sec_uid> 落域并让页面跑起来,再用 evaluate 在页面内 fetch(api, {credentials:'include', headers:{referer:'https://www.douyin.com/'}})。用户作品:/aweme/v1/web/aweme/post/?sec_user_id=&max_cursor=0&count=20&aid=6383,返回 {aweme_list:[{aweme_id,desc,video:{duration(ms),play_addr:{url_list}},statistics:{digg_count}}]};status_code 非 0 表示异常/风控。sec_uid 是用户主页 URL 末段那串长字符。评论:/aweme/v1/web/comment/list/?aweme_id=&count=10&cursor=0&aid=6383,返回 {comments:[{text,digg_count,user:{nickname}}]}。务必使用持久浏览器并已登录;即便如此抖音风控仍可能间歇失败,失败时按错误提示重试或重新登录。creator.douyin.com 下的发布/草稿/账号信息接口需创作者登录且更复杂,本配方不收录。"
},{
  "site": "facebook.com",
  "auth": "需登录持久浏览器;Facebook 反爬强,未登录/新会话常被挡",
  "entry": {
    "searchTop": "https://www.facebook.com/search/top?q={query}",
    "home": "https://www.facebook.com"
  },
  "recipes": ["facebook-search"],
  "notes": "Facebook 无可用公开 API,内容是混淆 class 名的 React 客户端渲染,只能按 ARIA role 粗粒度扒:[role=article](回退 [role=listitem])。配方:先 navigate 主域、再 navigate /search/top?q= → 等 4s 渲染 → 过滤文本>20 → 取标题 h2/h3/h4/strong、链接 a[href*=facebook.com/]、摘要取整块 textContent 前 150 字。⚠️ 这是最脆的一类:混淆 DOM + 强反爬 + 登录墙,结果偏粗;选择器随改版极易失效(失效则快速失败 → 回退现场 snapshot+extract)。能登录态访问时优先让 agent 现场操作。"
},{
  "site": "finance.sina.com.cn",
  "auth": "快讯/行情只读无需登录",
  "entry": {
    "home": "https://finance.sina.com.cn/",
    "newsApi": "https://app.cj.sina.com.cn/api/news/pc?page=1&size=<limit>&tag=0",
    "stockSuggestApi": "https://suggest3.sinajs.cn/suggest/type=11,31,41&key=<keyword>",
    "stockQuoteApi": "https://hq.sinajs.cn/list=<symbol>",
    "rollPage": "https://finance.sina.com.cn/roll/"
  },
  "recipes": ["sinafinance-news"],
  "notes": "7x24 快讯走公开 JSON API:app.cj.sina.com.cn/api/news/pc?page=1&size=<limit>&tag=0,无需登录、无需浏览器签名;sinafinance-news 配方 navigate 到该 URL 再读 body 即拿 JSON {result:{data:{feed:{list:[{id,create_time,rich_text(含HTML需strip),view_num}]}}}}。tag 可换分类(对应新浪 API tag id):10=A股 1=宏观 3=公司 4=数据 5=市场 102=国际 6=观点/央行 8=其它,0=全部。行情(A股/港股/美股)走 sinajs:先 suggest3.sinajs.cn/suggest/type=11,31,41&key=<名称或代码> 搜代码(11=A股 31=港股 41=美股),再 hq.sinajs.cn/list=<symbol> 取实时行情 —— 注意这两个接口返回 GBK 编码、且需带 Referer: https://finance.sina.com.cn,navigate+读 body 可能乱码,建议用 evaluate 在页面内 fetch 后用 new TextDecoder('gbk').decode(await r.arrayBuffer()) 解码,A股 symbol 形如 sh600519/sz300xxx、港股 hk<code>、美股 gb_<code>。滚动新闻 finance.sina.com.cn/roll/ 是 SPA DOM(.d_list_txt li),稳定性差,本配方只收录干净的 7x24 快讯 JSON。"
},{
  "site": "finance.yahoo.com",
  "auth": "只读行情无需登录;v8 chart 接口对匿名请求开放",
  "entry": {
    "quoteApi": "https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?interval=1d&range=1d",
    "quotePage": "https://finance.yahoo.com/quote/<symbol>/"
  },
  "recipes": ["yahoo-finance-quote"],
  "notes": "公开行情走 v8 chart JSON 接口,无需登录、无需 cookie:GET https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?interval=1d&range=1d。该主机是纯 JSON API,可直接 navigate 后读 document.body.innerText 再 JSON.parse(yahoo-finance-quote 配方已封装,结果直接在 output(已自动解包))。响应结构 {chart:{result:[{meta:{symbol,shortName,longName,regularMarketPrice,previousClose,chartPreviousClose,regularMarketDayHigh,regularMarketDayLow,regularMarketVolume,fiftyTwoWeekHigh,fiftyTwoWeekLow,currency,fullExchangeName,...},timestamp:[...],indicators:{quote:[{open,high,low,close,volume}]}}],error:null}}。涨跌幅需自己用 price-previousClose 算(接口不直接给)。要历史 K 线把 range 调成 5d/1mo/1y、interval 调成 1d/1wk/1mo,timestamp + indicators.quote[0] 是逐根数据。symbol 例:股票 AAPL/MSFT、指数 ^GSPC(标普)/^IXIC(纳指)、加密 BTC-USD、外汇 EURUSD=X。若 query1 被限流可换 query2.finance.yahoo.com。"
},{
  "site": "huggingface.co",
  "auth": "只读无需登录",
  "entry": {
    "searchApi": "https://huggingface.co/api/models?search=&limit=20"
  },
  "recipes": ["hf-model-search"],
  "notes": "搜索走公开 Hugging Face API(huggingface.co/api/models?search=&limit=20),返回顶层 JSON 数组 [{id,downloads,likes,pipeline_tag,library_name,createdAt,...}](无外层包裹对象);直接 navigate 到该 URL 再读 body 即拿到 JSON。id 即模型仓库名,页面地址为 https://huggingface.co/{id}。可加 sort=downloads&direction=-1 排序。"
},{
  "site": "imdb.com",
  "auth": "只读搜索/详情/榜单无需登录(公开页面)",
  "entry": {
    "searchPage": "https://www.imdb.com/find/?q=<query>&ref_=nv_sr_sm&language=en-US",
    "titlePage": "https://www.imdb.com/title/<ttID>/?language=en-US",
    "namePage": "https://www.imdb.com/name/<nmID>/?language=en-US",
    "top250": "https://www.imdb.com/chart/top/?language=en-US",
    "mostPopular": "https://www.imdb.com/chart/moviemeter/?language=en-US"
  },
  "recipes": ["imdb-search"],
  "notes": "IMDb 无干净的公开 JSON 接口,数据嵌在页面里,所以套路统一是:先 navigate 到目标页(URL 带 &language=en-US 稳定结构),再在页面内解析嵌入的 JSON。两类数据源:\n• 搜索页 /find/?q=<词>:数据在 <script id=\"__NEXT_DATA__\"> 里,props.pageProps.titleResults.results[] 与 nameResults.results[],每条形如 {index:'tt0133093'|'nm...', listItem:{titleText/nameText/releaseYear/titleType,...}}。结果可能晚于 load 才注入,需轮询等待(imdb-search 配方已封装,结果直接在 output(已自动解包),含 title/name 两类,字段 id/kind/title/year/type/url)。\n• 详情页 /title/<ttID>/ 与榜单页 /chart/top/、/chart/moviemeter/:数据在 <script type=\"application/ld+json\"> 里。详情页取 @type 为 Movie/TVSeries/TVEpisode 等的对象(name,datePublished,aggregateRating.{ratingValue,ratingCount},genre,director/creator,actor,duration(ISO PT2H28M),contentRating,description)。榜单页取 @type='ItemList' 的对象,itemListElement[] 每条 {position,item:{name,url,aggregateRating}}。\n• id 格式:影视 tt + 7~8 位数字,人物 nm + 7~8 位。IMDb 偶尔出机器人验证页(标题含 Robot Check / captcha),命中时换正常浏览器会话或稍后重试。"
},{
  "site": "instagram.com",
  "auth": "需要登录:在持久浏览器里登录 Instagram,接口靠会话 cookie 鉴权(同源 fetch + credentials:include),未登录会被风控返回非 JSON",
  "entry": {
    "home": "https://www.instagram.com",
    "webProfileInfo": "https://www.instagram.com/api/v1/users/web_profile_info/?username=<username>",
    "topSearch": "https://www.instagram.com/web/search/topsearch/?query=<query>&context=user",
    "userFeed": "https://www.instagram.com/api/v1/feed/user/<userId>/?count=12"
  },
  "recipes": ["instagram-profile"],
  "notes": "策略:cookie/login。关键姿势——先 navigate 到 https://www.instagram.com(取得同源 + 登录 cookie),再在页面内 fetch 内部 web API,所有请求都要带 header {'X-IG-App-ID':'936619743392459'}(这是 IG 网页端公开的固定 app id,不是用户私密 token)和 credentials:'include',否则会 401/403。直接 navigate 到 JSON URL 会被喂 SPA HTML。instagram-profile 配方走 users/web_profile_info,返回 data.user:{username,full_name,biography,is_verified,is_private,id,edge_followed_by.count(粉丝),edge_follow.count(关注),edge_owner_to_timeline_media.count(发帖数)};配方里顺带回传了 userId,可用于下面取该用户帖子。其它常用读接口(同样在页面内 fetch + 上述 header):1) 搜账号 web/search/topsearch/?query=<q>&context=user 返回 {users:[{user:{username,full_name,is_verified,is_private}}]};2) 取某用户帖子 api/v1/feed/user/<userId>/?count=12 返回 {items:[{caption:{text},like_count,comment_count,media_type(1=图/2=视频/8=多图),taken_at}]}(userId 先从 web_profile_info 拿)。JSON.parse 失败一律按未登录/风控处理,提示用户先在持久浏览器登录。"
},{
  "site": "jd.com",
  "auth": "需要在持久浏览器登录京东;价格与详情图依赖登录态 + 滚动懒加载",
  "entry": {
    "itemPage": "https://item.jd.com/<sku>.html"
  },
  "recipes": ["jd-item"],
  "notes": "京东无稳定公开接口,商品详情靠扒 DOM。注意两点:(1) 价格、店铺、详情区大图是登录后 + 滚动到视口才加载的,所以必须先 navigate 到 item.jd.com/<sku>.html、分段 scrollTo 触发懒加载、再读 DOM(jd-item 配方已封装,结果直接在 output(已自动解包))。(2) 未登录时价格常拿不到,会回退成提示文案。\n关键选择器:价格 .J-p-<sku> 或 .p-price strong;标题 .sku-name / .product-title;店铺 .J-shop-name;商品图 img[src*=\"360buyimg.com\"](去重后取前若干张)。规格参数没有结构化容器,从 document.body.innerText 里「商品编号 ... 包装清单」之间按行成对(键/值)切出。sku 即商品 URL 里的数字 id,如 https://item.jd.com/100291143898.html 的 100291143898。"
},{
  "site": "linkedin.com",
  "auth": "需登录持久浏览器(csrf-token = JSESSIONID cookie 值)",
  "entry": {
    "jobsVoyager": "/voyager/api/voyagerJobsDashJobCards?decorationId=...JobSearchCardsCollection-220&count=25&q=jobSearch&query=(origin:JOB_SEARCH_PAGE_OTHER_ENTRY,keywords:{kw},spellCorrectionEnabled:true)&start=0",
    "feed": "https://www.linkedin.com/feed/"
  },
  "recipes": ["linkedin-jobs-search"],
  "notes": "LinkedIn 有内部 Voyager API,同源可调:页面内 fetch,header 带 csrf-token(取自 JSESSIONID cookie、去掉首尾引号)+ x-restli-protocol-version:2.0.0。职位搜索端点 voyagerJobsDashJobCards,query 是 (origin:...,keywords:KW,...) 的 DSL。响应 elements[].jobCardUnion.jobPostingCard → 标题 jobPostingTitle/title.text,职位 id 从 jobPostingUrn 里取数字,详情页 /jobs/view/{id}。⚠️ 两点:① 搜索只覆盖职位(不是通用人/帖搜索);② LinkedIn 对自动化封号较狠,属高账号风险,慎用、低频用。可加 company/experience/jobType/timePostedRange 过滤(扩 query DSL)——按需 saveRecipe 派生。"
},{
  "site": "linux.do",
  "auth": "Discourse 论坛,公开话题免登录即可读 JSON;登录态(持久浏览器登录 linux.do)可读受限分类并降低 Cloudflare 拦截概率",
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
      "notes": "JSON {topic_list:{topics:[{id,title,fancy_title,posts_count,like_count,views,created_at,...}]}};话题 URL = https://linux.do/t/topic/<id>"
    }
  ],
  "recipes": ["linuxdo-latest"],
  "notes": "linux.do 是基于 Discourse 的论坛,所有列表/详情都有标准 .json 端点。关键:不要直接 navigate 到 *.json——Cloudflare 会对非同源访问喂挑战页/SPA HTML。正确姿势是先 navigate 到 https://linux.do,再用 evaluate 步在页面内 fetch(相对路径, {credentials:'include'}):同源 + 带 cookie,公开内容免登录也能读、登录后还能读受限分类。已收录 linuxdo-latest(最新话题,走 /latest.json)。其它常用读流程同理在页面内 fetch:热门 /top.json?period=weekly(结构同 topic_list.topics,含 period 选 all/daily/weekly/monthly/quarterly/yearly);搜索 /search.json?q=<encodeURIComponent(keyword)>(响应 {topics:[{id,title,views,like_count,posts_count}]});话题详情+楼层 /t/<id>.json(响应 {post_stream:{posts:[{username,cooked(HTML正文,需去标签),like_count,created_at,post_number}]}},post_number===1 为主楼);分类 /categories.json(category_list.categories[{name,slug,id,topic_count}]);标签 /tags.json(tags[{id,name,slug,count}]);某用户创建的话题 /topics/created-by/<username>.json。回复数 = posts_count - 1。"
},{
  "site": "lobste.rs",
  "auth": "只读无需登录",
  "entry": {
    "hottest": "https://lobste.rs/hottest.json",
    "newest": "https://lobste.rs/newest.json",
    "active": "https://lobste.rs/active.json",
    "tag": "https://lobste.rs/t/{tag}.json"
  },
  "recipes": ["lobsters-feed"],
  "notes": "lobste.rs 的稳定读接口是各 feed 的 .json:hottest/newest/active(navigate 到该 URL 再 extract body 即拿 JSON 数组)。每条故事含 {short_id,title,url,score,comment_count,comments_url,created_at,submitter_user,tags,...}。按 tag 读用 https://lobste.rs/t/{tag}.json。注意:没有可用的 search.json(返回搜索页 HTML / 易被限流),要搜关键词只能拉 feed 后本地过滤。"
},{
  "site": "m.okjike.com",
  "auth": "公开用户主页/帖子/话题免登录即可读(数据走 Next.js SSR 内嵌 JSON);首页关注流、搜索等个性化内容需登录(走 web.okjike.com,扒 React fiber,较脆弱)",
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
      "notes": "SSR <script type=\"application/json\"> 内 props.pageProps.posts[{content,type,likeCount,commentCount,actionTime,createdAt,id}];帖子 URL = https://web.okjike.com/originalPost/<id>"
    }
  ],
  "recipes": ["jike-user-posts"],
  "notes": "即刻数据获取分两条路。推荐路:移动站 m.okjike.com 是 Next.js SSR,页面里有一个 <script id=\"__NEXT_DATA__\" type=\"application/json\"> 节点,优先用 document.getElementById('__NEXT_DATA__')(比盲取第一个 application/json script 稳)、JSON.parse 它的 textContent 即可拿到 props.pageProps,无需调接口、公开内容免登录,稳定不踩反爬。已收录 jike-user-posts(用户动态,走 /users/<username>)。同模式的其它移动站读流程:帖子详情+评论 /originalPosts/<postId>(pageProps.post{user.screenName,content,likeCount,createdAt} + pageProps.comments[{user.screenName,content,likeCount,createdAt}]);话题/圈子帖子 /topics/<topicId>(pageProps.posts[{content,user.screenName,likeCount,commentCount,actionTime,id}]),帖子 URL 用 https://web.okjike.com/originalPost/<id> 拼。备用路(脆弱、需登录):web.okjike.com 是纯 CSR,首页关注流(/)和搜索(/search?q=<kw>)没有接口,只能 navigate 后遍历 DOM 元素([class*=\"_post_\"])、从 React fiber(__reactFiber$ 开头的 key 向上找含 data.id 的 memoizedProps)里抠帖子数据,DOM/类名变了就失效,本配方集不收录,需要时让模型现场扒。"
},{
  "site": "medium.com",
  "auth": "只读公开内容无需登录:走 Medium 公开 RSS feed",
  "entry": {
    "home": "https://medium.com",
    "tagFeed": "https://medium.com/feed/tag/<tag-slug>",
    "userFeed": "https://medium.com/feed/@<username>",
    "publicationFeed": "https://medium.com/feed/<publication>"
  },
  "recipes": ["medium-tag-feed"],
  "notes": "Medium 没有公开的 JSON 读接口,网页正文是 React 渲染、直接扒 DOM 很脆;但它对外提供稳定的公开 RSS 2.0 feed(无需登录),这是最可靠的只读入口。姿势:先 navigate 到 https://medium.com 取同源,再在页面内 fetch RSS 文本、用 DOMParser('text/xml') 解析。RSS 每个 <item> 字段:title、link、guid、dc:creator(作者,命名空间标签要用 getElementsByTagName('dc:creator') 取,querySelector 对带冒号的标签名不可靠)、pubDate、category(多个标签)、description(CDATA 包裹的 HTML 摘要,需 strip 掉标签)。medium-tag-feed 配方封装的是 /feed/tag/<slug>(话题最新文章)。其它公开 RSS 端点同理可解析:1) 某作者文章 /feed/@<username>;2) 某 publication 文章 /feed/<publication-slug>。注意:Medium 站内搜索(/search?q=)没有 RSS / JSON 接口,只能扒渲染 DOM,不稳定,本站不提供搜索配方——要找文章优先用 tag/作者/publication feed。tag slug 用连字符英文,如 artificial-intelligence、machine-learning。"
},{
  "site": "mp.weixin.qq.com",
  "auth": "无需登录:公众号文章分享链接是公开页面,持久浏览器直接打开即可(真浏览器执行 JS 后正文可见,不需要伪装微信 UA)",
  "entry": {
    "article": "https://mp.weixin.qq.com/s/<key>",
    "articleLegacy": "https://mp.weixin.qq.com/s?__biz=<biz>&mid=<mid>&idx=<idx>&sn=<sn>"
  },
  "recipes": ["wechat-article"],
  "notes": "关键选择器:标题 #activity-name、公众号名 #js_name、作者 #js_author_name(部分文章没有)、发布时间 #publish_time(由页面内联 JS 填充,load 后可读)、正文容器 #js_content。正文图片是懒加载:真实地址在 img[data-src] 而非 src;图片域名 mmbiz.qpic.cn 有防盗链,浏览器外直接下载需带 Referer: https://mp.weixin.qq.com/。wechat-article 配方返回全文文本(超 4 万字符截断并标 truncated)与图片地址列表。能力边界:mp.weixin.qq.com 没有免登录的搜索/列表接口,「列出某公众号历史文章」做不到,文章 URL 需由用户提供(聊天分享/收藏)。失败模式:#js_content 缺失 = 链接过期(带 chksm 的临时链接有时效)、文章被删除/违规屏蔽、或频繁访问触发环境验证页——遇验证页应停下告知用户,不要反复重试。"
},{
  "site": "news.ycombinator.com",
  "auth": "只读无需登录",
  "entry": {
    "home": "https://news.ycombinator.com/",
    "searchApi": "https://hn.algolia.com/api/v1/search?tags=story&query="
  },
  "pages": [
    { "type": "front", "url": "https://news.ycombinator.com/", "container": ".athing", "notes": "标题在 .titleline a" }
  ],
  "recipes": ["hn-search"],
  "notes": "搜索走公开 Algolia API(hn.algolia.com/api/v1/search?tags=story&query=),返回 JSON {hits:[{title,url,author,points,objectID,created_at,...}]};直接 navigate 到该 URL 再读 body 即拿到 JSON。首页 DOM 列表是 .athing 行。"
},{
  "site": "npmjs.com",
  "auth": "只读无需登录",
  "entry": {
    "home": "https://www.npmjs.com/",
    "searchApi": "https://registry.npmjs.org/-/v1/search?text="
  },
  "recipes": ["npm-search"],
  "notes": "搜索走 npm registry 的公开 API(registry.npmjs.org/-/v1/search?text=&size=20),返回 JSON {objects:[{package:{name,version,description,date,links,publisher,...}}],total,time};直接 navigate 到该 URL 再读 body 即拿到 JSON。"
},{
  "site": "pixiv.net",
  "auth": "必须登录:Ajax 接口对未登录返回 401/403,需在持久浏览器里登录 pixiv.net",
  "entry": {
    "home": "https://www.pixiv.net",
    "searchApi": "https://www.pixiv.net/ajax/search/illustrations/<word>?word=<word>&order=date_d&mode=all&p=1&s_mode=s_tag_full&type=illust_and_ugoira",
    "rankingApi": "https://www.pixiv.net/ranking.php?mode=daily&p=1&format=json",
    "illustApi": "https://www.pixiv.net/ajax/illust/<illustId>"
  },
  "recipes": ["pixiv-search"],
  "notes": "Pixiv 全套读接口都是 www.pixiv.net 同源的 Ajax,返回统一是 {error:false, body:...}(失败按 HTTP status 区分:401/403=未登录、404=不存在)。必须先 navigate 到 https://www.pixiv.net 带上 cookie,再在页面内 fetch(credentials:'include')。搜索:/ajax/search/illustrations/<word>?word=<word>&order=&mode=&p=&s_mode=s_tag_full&type=illust_and_ugoira —— 关键词要同时出现在 path 和 word 参数;order 可选 date_d/date/popular_d/popular_male_d/popular_female_d,mode 可选 all/safe/r18;结果在 body.illust.data[],每条 {id,title,userName,userId,pageCount,bookmarkCount,tags[]}。排行榜:/ranking.php?mode=daily|weekly|monthly|rookie|original|male|female&p=1&format=json,结果在 contents[],每条 {rank,title,user_name,user_id,illust_id,illust_page_count,illust_bookmark_count}。作品详情:/ajax/illust/<id>,body 含 {illustTitle,userName,pageCount,bookmarkCount,likeCount,viewCount,tags.tags[].tag,createDate}。作者作品列表两步:先 /ajax/user/<uid>/profile/all 取所有 illust id,再批量 /ajax/user/<uid>/profile/illusts?ids[]=...&work_category=illustManga(每批最多 48 个 id)。作品页 URL = https://www.pixiv.net/artworks/<id>。"
},{
  "site": "producthunt.com",
  "auth": "只读无需登录(公开 Atom feed)",
  "entry": {
    "latest": "https://www.producthunt.com/feed",
    "byCategory": "https://www.producthunt.com/feed?category=<slug>"
  },
  "recipes": ["producthunt-feed"],
  "notes": "Product Hunt 的稳定免登录读接口是官方 Atom feed:https://www.producthunt.com/feed,加 ?category=<slug> 可按分类过滤(常用 slug:ai-agents、ai-chatbots、developer-tools、productivity、design-creative、no-code-platforms、vibe-coding)。producthunt-feed 配方拉的是全部最新发布(无入参);要按分类筛,直接 navigate 到带 category 的 feed URL 再 extract body。返回是 Atom XML 文本(不是 JSON),每个产品在 <entry> 里:<title> 产品名、<content> 里 HTML 含 tagline(去标签后取首段)、<author><name> 提交者、<published> 发布时间(ISO,取前 10 位是日期)、<link href> 产品页 URL。Product Hunt 按太平洋时区出榜,feed 里最新日期那批就是『今日发布』。注意:带票数(votes)的热榜和分类最佳榜只在首页/分类页 DOM 渲染,没有公开 JSON,需要 DOM 抓取,本配方不覆盖。"
},{
  "site": "pubmed.ncbi.nlm.nih.gov",
  "auth": "只读无需登录",
  "entry": { "api": "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&term={query}" },
  "recipes": ["pubmed-search"],
  "notes": "NCBI E-utilities esearch 公开接口（PubMed 检索走 eutils 域名）。返回 JSON {esearchresult:{count,idlist:[PMID,...],querytranslation,...}}。拿到 idlist 后可再用 esummary/efetch 取详情。无 key 时有速率限制。"
},{
  "site": "pypi.org",
  "auth": "只读无需登录",
  "entry": {
    "home": "https://pypi.org/",
    "packageApi": "https://pypi.org/pypi/<package>/json"
  },
  "recipes": ["pypi-package"],
  "notes": "查单个包走 PyPI 的公开 JSON API(pypi.org/pypi/<package>/json),返回 JSON {info:{name,version,summary,author,license,home_page,requires_python,...},releases:{...},urls:[...]};直接 navigate 到该 URL 再读 body 即拿到 JSON。该端点是查指定包,不是关键词搜索。"
},{
  "site": "reddit.com",
  "auth": "公开内容无需登录;受限/个人化内容(已登录的首页 r/all、私密版块、点赞/收藏)走持久浏览器登录态",
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
  "notes": "关键:不要直接 navigate 到 /r/<sub>/.json——Reddit 反爬会给非同源访问喂 SPA HTML。正确姿势是先 navigate 到 https://www.reddit.com,再用 evaluate 步在页面内 fetch('/r/<sub>/hot.json?limit=25&raw_json=1', {credentials:'include'}):同源 + 带 cookie,登录态也能拿个人化结果。reddit-listing 配方已封装此流程,结果直接在 output(已自动解包) 数组。其它端点同理:/hot.json、/r/<sub>/search.json?q=&restrict_sr=on、/r/<sub>/top.json?t=week、/user/<name>/about.json。raw_json=1 避免 HTML 实体转义。"
},{
  "site": "reuters.com",
  "auth": "走持久浏览器会话(带 cookie);Reuters 有强反爬 + 区域/付费墙,未登录或被风控时接口返回非 JSON",
  "entry": {
    "home": "https://www.reuters.com",
    "searchApi": "https://www.reuters.com/pf/api/v3/content/fetch/articles-by-search-v2?query=<urlencoded-json>"
  },
  "recipes": ["reuters-search"],
  "notes": "Reuters 站内搜索走 PageForge 接口:/pf/api/v3/content/fetch/articles-by-search-v2?query=<把一段 JSON urlencode>。那段 JSON 形如 {keyword, offset:0, orderby:'display_date:desc', size, website:'reuters'}。响应 {result:{articles:[{title 或 headlines.basic, display_date(ISO), taxonomy.section.name, canonical_url(站内相对路径)}], ...}}。文章 URL = 'https://www.reuters.com' + canonical_url。关键:必须先 navigate 到 https://www.reuters.com 再在页面内同源 fetch(带 credentials:'include'),直接跨域请求会被反爬/CORS 挡。Reuters 风控较强,撞墙时配方会抛中文提示让用户在持久浏览器先正常访问/登录;若长期取不到,改用 BBC 等公开 RSS 源更稳。"
},{
  "site": "scrapethissite.com",
  "auth": "无需登录:公开的抓取练习沙盒站",
  "entry": {
    "forms": "https://www.scrapethissite.com/pages/forms/"
  },
  "recipes": ["hockey-search"],
  "notes": "抓取练习沙盒,hockey-search 是交互步(type+submit → extract)的示例配方,也可用作端到端验证配方引擎是否正常的探针站。"
},{
  "site": "smzdm.com",
  "auth": "建议持久浏览器登录:未登录也能搜,但登录态结果更全、更少风控/验证码",
  "entry": {
    "home": "https://www.smzdm.com/",
    "searchPage": "https://search.smzdm.com/?c=home&s=<keyword>&v=b"
  },
  "recipes": ["smzdm-search"],
  "notes": "什么值得买没有可用的公开 JSON 搜索接口(旧的 search.smzdm.com/ajax/ 已 404),只能 navigate 到搜索结果页 search.smzdm.com/?c=home&s=<keyword>&v=b 后从 DOM 抓取。smzdm-search 配方用 extract 抓 li.feed-row-wide 列表:标题取 h5.feed-block-title a 的 title 属性、价格取 .z-highlight 文本、商城取 .z-feed-foot-r .feed-block-extras span 文本、链接取 h5.feed-block-title a 的 href。评论数在 .feed-btn-comment(文本里含数字,需自行解析,本配方未单列)。务必用持久浏览器:登录态下结果更完整,且能规避部分风控。若 DOM 结构变动导致抓不到,先用 snapshot(带 selector 收窄到 li.feed-row-wide)确认真实结构再调整选择器。"
},{
  "site": "stackoverflow.com",
  "auth": "只读无需登录",
  "entry": {
    "searchApi": "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=&site=stackoverflow"
  },
  "recipes": ["stackoverflow-search"],
  "notes": "搜索走公开 Stack Exchange API(api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=&site=stackoverflow),返回 JSON {items:[{title,link,score,answer_count,is_answered,question_id,tags,...}],has_more,quota_remaining};直接 navigate 到该 URL 再读 body 即拿到 JSON。响应默认 gzip,浏览器自动解压。无 key 时配额较低(quota_remaining 字段可见),site 参数可换其它 Stack Exchange 站点。"
},{
  "site": "store.steampowered.com",
  "auth": "公开,无需登录;Steam 商店搜索 / 精选分类接口对匿名请求开放",
  "entry": {
    "home": "https://store.steampowered.com/",
    "search": "https://store.steampowered.com/api/storesearch/?cc=us&l=english&term=<keyword>",
    "featured": "https://store.steampowered.com/api/featuredcategories/?cc=us&l=english"
  },
  "recipes": ["steam-search"],
  "notes": "策略 PUBLIC。两个干净的只读接口:(1) /api/storesearch/?cc=<国家码>&l=english&term=<词> 返回 {total, items:[{id(=AppID), type, name, price:{currency, initial, final}, metascore, platforms:{windows,mac,linux}, tiny_image, controller_support}]};price.final 是货币最小单位整数(999 = $9.99)。(2) /api/featuredcategories/?cc=&l= 返回首页精选,其中 top_sellers.items:[{id, name, final_price, original_price, discount_percent, currency, header_image}] 是热销榜。cc 控制区域定价(us/cn/jp 等),l 控制语言。两接口对匿名都直接返回 JSON,但封装成「先 navigate 到 store.steampowered.com 再同源 evaluate fetch」以规避偶发区域门/风控。详情页统一拼 https://store.steampowered.com/app/<AppID>。"
},{
  "site": "substack.com",
  "auth": "搜索/浏览只读无需登录;付费/订阅内容才需要持久浏览器登录态",
  "entry": {
    "home": "https://substack.com",
    "postSearch": "https://substack.com/api/v1/post/search?query=<kw>&page=0&includePlatformResults=true",
    "profileSearch": "https://substack.com/api/v1/profile/search?query=<kw>&page=0"
  },
  "recipes": ["substack-search"],
  "notes": "Substack 有公开 JSON 搜索接口,且都在 substack.com 同源下。文章搜索:/api/v1/post/search?query=&page=0&includePlatformResults=true,返回 {results:[{title, publishedBylines:[{name}], post_date(ISO), description/subtitle/truncated_body_text, canonical_url}]}。作者/Newsletter 搜索:/api/v1/profile/search?query=&page=0,返回 {results:[{name, bio, primaryPublication:{name, hero_text, subdomain, custom_domain}}]},Newsletter 主页 = custom_domain 有就 https://<custom_domain>,否则 https://<subdomain>.substack.com。substack-search 配方用的是 post/search;搜 Newsletter 把 fn 里的路径换成 profile/search 即可。关键:不要直接 navigate 到 api 路径(会被喂前端 SPA HTML),先 navigate 到 https://substack.com 再在页面内同源 fetch。某个 Newsletter 的历史文章可拉 https://<pub>.substack.com/api/v1/archive?sort=new&limit=20 (返回文章 JSON 数组)。"
},{
  "site": "tieba.baidu.com",
  "auth": "热议话题榜公开免登录;搜索/吧内帖子列表/帖子正文需登录态(cookie)且依赖 DOM 结构,易被百度安全验证拦",
  "entry": {
    "home": "https://tieba.baidu.com",
    "hotTopics": "https://tieba.baidu.com/hottopic/browse/topicList?res_type=1",
    "forum": "https://tieba.baidu.com/f?kw=<吧名>&pn=<(page-1)*50>",
    "search": "https://tieba.baidu.com/f/search/res?qw=<keyword>&pn=1",
    "thread": "https://tieba.baidu.com/p/<threadId>?pn=<page>"
  },
  "pages": [
    {
      "type": "hot-list",
      "url": "https://tieba.baidu.com/hottopic/browse/topicList?res_type=1",
      "notes": "服务端渲染列表 li.topic-top-item:标题 a.topic-text(href 为话题链接)、讨论量 span.topic-num、简介 p.topic-top-item-desc"
    }
  ],
  "recipes": ["tieba-hot-topics"],
  "notes": "贴吧没有公开稳定的读 JSON API,绝大多数页面是登录态 + DOM 渲染。唯一干净可收录的是热议话题榜(tieba-hot-topics):/hottopic/browse/topicList?res_type=1 是服务端渲染,navigate 后用 extract 按 li.topic-top-item + 子选择器抓即可,免登录、不踩反爬。其它流程已评估为脆弱、暂不收录,需要时让模型现场处理:(1) 搜索 /f/search/res?qw=<encodeURIComponent(kw)>&pn=1——结果卡片 .threadcardclass.thread-new3.index-feed-cards 是 Vue 组件,thread_id 藏在 action bar 的 __vue__ 内部 props(businessInfo.thread_id),仅扒可见 DOM 不可靠,且常触发『百度安全验证』;(2) 吧内帖子列表 /f?kw=<吧名>——真实数据要 POST tieba.baidu.com/c/f/frs/page_pc 且需要对参数做私有 sign 签名,无法用声明式配方表达;(3) 帖子正文 /p/<id>——正文/楼层都从 .pb-content-wrap、.pb-comment-item 等节点的 Vue __vue__ props 里抠,DOM 一变就失效。统一注意:这些页面都需要在持久浏览器登录百度并自然访问以降低风控。"
},{
  "site": "v2ex.com",
  "auth": "公开内容(热门/最新/节点/主题/回复/用户资料)全部无需登录,走官方 JSON API;签到等写操作才需登录态",
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
      "notes": "返回数组 [{id,title,url,replies,node:{title,name},member:{username},created,...}]"
    }
  ],
  "recipes": ["v2ex-hot"],
  "notes": "V2EX 提供稳定的公开 v1 JSON API,直接 navigate 到端点即返回原始 JSON(非 SPA HTML),无需登录、无需同源 fetch。已收录 v2ex-hot(热门主题)。其它常用读端点可直接 navigate + extract body 取 JSON:最新主题 /api/topics/latest.json;主题详情 /api/topics/show.json?id=<id>(返回单元素数组,含 title/content/member.username/node.title/replies/url);节点主题列表 /api/topics/show.json?node_name=<node>(如 python、apple,最多 20 条);主题回复 /api/replies/show.json?topic_id=<id>(数组,含 member.username/content/created);全部节点 /api/nodes/all.json(含 name/title/topics/stars);用户资料 /api/members/show.json?username=<name>。主题页 URL 直接用响应里的 item.url 字段。"
},{
  "site": "weibo.com",
  "auth": "需要登录态:微博 ajax 接口对未登录会话返回非 JSON 或 ok=false,请在持久浏览器登录 weibo.com 后使用",
  "entry": {
    "home": "https://weibo.com",
    "hotBand": "https://weibo.com/ajax/statuses/hot_band",
    "searchPage": "https://s.weibo.com/weibo?q=<keyword>"
  },
  "recipes": ["weibo-hot"],
  "notes": "关键:不要直接 navigate 到 /ajax/statuses/hot_band——非同源/未登录访问会被喂 SPA HTML。正确姿势是先 navigate 到 https://weibo.com,再用 evaluate 步在页面内 fetch('/ajax/statuses/hot_band', {credentials:'include'}):同源 + 带 cookie。响应结构 {ok:1,data:{band_list:[{realpos,word,num,category,label_name}]}};热词详情可拼 https://s.weibo.com/weibo?q=%23<word>%23(井号包裹的话题搜索)。注意:搜索(s.weibo.com)和首页 feed(/ajax/feed/unreadfriendstimeline,需先取自身 uid)在上游是 DOM 抓取或需额外 uid 推导,稳定性差,本配方只收录干净的 hot_band 热搜读接口。务必使用持久浏览器(带登录态)。"
},{
  "site": "weread.qq.com",
  "auth": "搜索/榜单只读无需登录;书籍详情走私有接口 i.weread.qq.com,需在持久浏览器登录微信读书",
  "entry": {
    "home": "https://weread.qq.com/",
    "searchApi": "https://weread.qq.com/web/search/global?keyword=<keyword>",
    "rankingApi": "https://weread.qq.com/web/bookListInCategory/<category>?rank=1",
    "bookInfoApi": "https://i.weread.qq.com/book/info?bookId=<bookId>"
  },
  "recipes": ["weread-search"],
  "notes": "公开 Web 接口在 weread.qq.com/web/* 下,Node 直连即可,无需登录。搜索:/web/search/global?keyword=,返回 JSON {books:[{bookInfo:{title,author,bookId,category}}]};weread-search 配方直接 navigate 到该 URL 再读 body 即拿 JSON。榜单:/web/bookListInCategory/<category>?rank=1,category 传 all(全部)、rising(飙升)或数字分类 ID,返回 {books:[{bookInfo:{title,author,bookId},readingCount}]},同样可 navigate+读 body。书籍详情走私有接口 i.weread.qq.com/book/info?bookId=,需登录:先 navigate 到 https://weread.qq.com/ 落域,再用 evaluate 在页面内 fetch('https://i.weread.qq.com/book/info?bookId='+id,{credentials:'include',headers:{Origin:'https://weread.qq.com',Referer:'https://weread.qq.com/'}}),返回 {title,author,publisher,category,intro,newRating};未登录会返回 errcode -2010/-2012,需重新登录。书架/笔记等更深入的个性化数据上游靠 localStorage 快照 + DOM,稳定性差,本配方不收录。"
},{
  "site": "wikipedia.org",
  "auth": "只读无需登录",
  "entry": {
    "searchApi": "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=&srlimit=20&format=json&utf8=1"
  },
  "recipes": ["wikipedia-search"],
  "notes": "搜索走公开 MediaWiki API(/w/api.php?action=query&list=search&srsearch=&srlimit=20&format=json&utf8=1),返回 JSON {query:{search:[{title,snippet,pageid,size,wordcount,timestamp,...}]}};直接 navigate 到该 URL 再读 body 即拿到 JSON。srlimit 控制条数(默认 10、上限 50),utf8=1 让非 ASCII 正常返回。snippet 内含 HTML 高亮标记。条目页地址 https://<lang>.wikipedia.org/wiki/<title 下划线代空格>。en. 子域可换成其它语言子域。"
},{
  "site": "www.coupang.com",
  "auth": "需要登录态 + 真浏览器:Coupang 反爬极严(Akamai),未登录或非浏览器会话访问搜索接口会被喂 HTML/挑战页;请在持久浏览器登录 coupang.com 后使用",
  "entry": {
    "home": "https://www.coupang.com/",
    "searchPage": "https://www.coupang.com/np/search?q=<keyword>&channel=user&page=1",
    "searchJson": "https://www.coupang.com/np/search?q=<keyword>&channel=user&page=<n>"
  },
  "recipes": ["coupang-search"],
  "notes": "策略 COOKIE/同源 fetch。关键:不要直接 navigate 到搜索 JSON——非同源/未登录/非浏览器访问会被反爬喂 HTML 或挑战页。正确姿势:先 navigate 到 https://www.coupang.com/np/search?q=<词>&channel=user&page=1(让浏览器过一次反爬、建立会话),再用 evaluate 在页面内 fetch('/np/search?q=<词>&channel=user&page=<n>', {credentials:'include'})。响应是 JSON 时,商品数组在 data.products / data.productList / products / productList / items 之一;单条字段命名不统一,常见 {productId, title|name|productName, price|salePrice|finalPrice, originalPrice|basePrice, rating, reviewCount}。务必先判断 responseText 是否以 '<' 开头(HTML=被挡),被挡时如实报「需登录/被反爬」。商品页统一拼 https://www.coupang.com/vp/products/<productId>。上游还有 JSON-LD / __NEXT_DATA__ / DOM 多重兜底,但都是 DOM 抓取、稳定性差,本配方只走干净的 JSON 接口路径。"
},{
  "site": "www.xiaoyuzhoufm.com",
  "auth": "公开内容无需登录;小宇宙(Next.js 静态导出)把页面数据写在 <script id=\"__NEXT_DATA__\">,在真浏览器里页面加载后即可读到",
  "entry": {
    "podcast": "https://www.xiaoyuzhoufm.com/podcast/<podcastId>",
    "episode": "https://www.xiaoyuzhoufm.com/episode/<episodeId>"
  },
  "recipes": ["xiaoyuzhou-podcast"],
  "notes": "策略:页面内 __NEXT_DATA__ 读取(免登录)。小宇宙没有公开稳定的搜索接口,只能按已知 ID 读详情(ID 取自 xiaoyuzhoufm.com 的 URL 路径)。关键:不要直接 navigate 到任何 ajax/api 子域(会要鉴权头);正确姿势是 navigate 到 /podcast/<id> 或 /episode/<id> 页面,wait load 后用 evaluate 读 window.__NEXT_DATA__.props.pageProps。结构:podcast 页 pageProps.podcast = {title, author, brief(简介), subscriptionCount(订阅数), episodeCount(单集总数), latestEpisodePubDate, episodes:[{eid, title, duration(秒), playCount, pubDate}]}(SSR 内嵌最近约 15 集);episode 页 pageProps.episode = {title, podcast:{title}, duration(秒), playCount, commentCount, clapCount(点赞), pubDate}。注意:用 curl 裸抓时若 ID 失效页面会回退到 /404 且 pageProps 为空 —— 这是 ID 问题,不是接口失效;务必用有效 ID 并在真浏览器里执行。"
},{
  "site": "wx.zsxq.com",
  "auth": "需登录:知识星球用 httpOnly cookie(分布在 zsxq.com 子域),无法读 cookie 判断登录态——只能靠 api 调用是否返回 JSON 判断。在持久浏览器登录 wx.zsxq.com 后,登录态随同源 fetch 自动带上",
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
      "notes": "响应 {resp_data:{dynamics:[{create_time,action,topic:{topic_id,type,group:{name},owner:{name},title,talk:{text,owner},comments_count,likes_count}}]}};话题 URL = https://wx.zsxq.com/topic/<topic_id>"
    }
  ],
  "recipes": ["zsxq-dynamics"],
  "notes": "知识星球页面域是 wx.zsxq.com,数据 API 在 api.zsxq.com。关键:必须先 navigate 到 https://wx.zsxq.com,再用 evaluate 步在页面内 fetch(api.zsxq.com 全路径, {credentials:'include'})——cookie 是 httpOnly 且跨子域,只有页面内带凭证发请求才会附带登录态。响应统一包一层:成功时数据在 resp_data(或 data),失败时 {succeeded:false, code, info};正文要从 topic 的 title / talk.text / question.text / answer.text / task.text / solution.text 里取第一个非空。已收录 zsxq-dynamics(跨所有星球的最新动态,无需 group_id)。其它读流程需要 group_id:列出我加入的星球 api.zsxq.com/v2/groups(resp_data.groups[{group_id,name,category:{title},statistics:{subscriptions_count,topics_count},user_specific:{join_time}}]);某星球话题列表 api.zsxq.com/v2/groups/<groupId>/topics?scope=all&count=<n>;星球内搜索 api.zsxq.com/v2/search/groups/<groupId>/topics?keyword=<encodeURIComponent(kw)>&count=<n>;话题详情 api.zsxq.com/v2/topics/<topicId>(resp_data.topic 或顶层即 topic),评论 api.zsxq.com/v2/topics/<topicId>/comments?sort=asc&count=<n>(resp_data.comments[{owner:{name},text,repliee:{name},likes_count}])。当前活跃星球 group_id 也可从页面 localStorage 的 target_group 取(JSON.parse 后读 group_id)。"
},{
  "site": "x.com",
  "auth": "需要登录:在持久浏览器里登录 x.com,内部 GraphQL 接口靠会话 cookie + 从 cookie 读出的 ct0(csrf token)鉴权,未登录无法调用",
  "entry": {
    "home": "https://x.com",
    "userByScreenName": "https://x.com/i/api/graphql/<queryId>/UserByScreenName?variables=...&features=...",
    "homeTimeline": "https://x.com/i/api/graphql/<queryId>/HomeTimeline?variables=...&features=..."
  },
  "recipes": ["twitter-profile"],
  "notes": "先看免登录捷径:读单条公开推文用 api.fxtwitter.com 的 x-tweet 配方,读公开用户资料也可走 api.fxtwitter.com/<screen_name>(见 api.fxtwitter.com siteguide),都不需要登录、不碰 x.com 风控;只有时间线/搜索/回复列表这类必须登录态的才走本站内部 GraphQL。x.com(原 twitter.com)所有数据走内部 GraphQL /i/api/graphql/<queryId>/<Operation>。策略:cookie/login + 页面内取 token。关键姿势——先 navigate 到 https://x.com 拿到同源 + 登录 cookie,在同一个 evaluate fn 里:(a) 从 document.cookie 读出 ct0 当 X-Csrf-Token;(b) 用网页端公开固定 bearer(配方里已内置,非用户私密 token)拼 Authorization;(c) 带 X-Twitter-Auth-Type:OAuth2Session、X-Twitter-Active-User:yes;(d) fetch 内部 graphql 接口、credentials:include。twitter-profile 配方封装 UserByScreenName,返回展平后的 {screen_name,name,bio,location,followers,following,tweets,likes,verified,created_at,url}。重要坑:GraphQL 的 queryId 会随网页端版本变化,配方里内置的是一个已知 fallback queryId,大多数时候可用;若某天返回非 JSON 或报 queryId expired,需要从当前页面加载的 client-web *.js bundle 里重新抓 'queryId:\"...\"' + 'operationName:\"UserByScreenName\"' 对应的最新 id 替换。其它读接口同理但不在配方内:1) 首页时间线 HomeTimeline(for-you,GET)/ HomeLatestTimeline(following,POST),响应在 data.home.home_timeline_urt.instructions[].entries[].content.itemContent.tweet_results.result(取 legacy.full_text/favorite_count/retweet_count 等),需要分页 cursor;2) 推文搜索 SearchTimeline 在网页端是 SPA 内部 XHR、queryId 同样易变,纯 fetch 复现不稳定,优先用 profile / timeline。"
},{
  "site": "xiaohongshu.com",
  "auth": "需登录持久浏览器:未登录搜索页会显示「登录后查看搜索结果」登录墙",
  "entry": {
    "searchNotes": "https://www.xiaohongshu.com/search_result?keyword={kw}&source=web_search_result_notes",
    "explore": "https://www.xiaohongshu.com/explore"
  },
  "recipes": ["xiaohongshu-search"],
  "notes": "小红书 web API(edith.xiaohongshu.com/.../search/notes)要 x-s/x-t 签名头(页面里混淆 JS window._webmsxyw 实时算),盲发 fetch 会被拒——所以不能走「页面内 fetch 内部 API」那条捷径,只能读页面渲染后的 DOM。配方:navigate 搜索页 → 检测登录墙(/登录后查看搜索结果/)→ 滚动 3 次加载 → 扒 section.note-item(跳过 .query-note-item):标题 .title/.note-title/a.title/.footer .title span;作者 a.author .name/.name/.nick-name;点赞 .count/.like-count;链接取 a.cover.mask 或 a[href*=/search_result//explore//note/]。⚠️ 必须登录态;选择器易随改版失效(失效则快速失败 → 回退现场 snapshot+extract,可 saveRecipe 更新)。"
},{
  "site": "xueqiu.com",
  "auth": "需登录:雪球行情/动态接口依赖登录 cookie,未登录会被风控(返回非 JSON 或 400)。在持久浏览器登录 xueqiu.com 后,登录态自动随同源 fetch 带上",
  "entry": {
    "home": "https://xueqiu.com",
    "search": "https://xueqiu.com/stock/search.json?code=<keyword>&size=<n>",
    "quote": "https://stock.xueqiu.com/v5/stock/batch/quote.json?symbol=<SYMBOL>",
    "hotStock": "https://stock.xueqiu.com/v5/stock/hot_stock/list.json?size=<n>&type=<10人气|12关注>",
    "hotStatus": "https://xueqiu.com/statuses/hot/listV3.json?source=hot&page=1",
    "feed": "https://xueqiu.com/v4/statuses/home_timeline.json?page=<p>&count=<n>",
    "watchlist": "https://stock.xueqiu.com/v5/stock/portfolio/stock/list.json?size=100&category=<1自选|2持仓|3关注>&pid=-1",
    "earningsDate": "https://stock.xueqiu.com/v5/stock/screener/event/list.json?symbol=<SYMBOL>&page=1&size=100"
  },
  "pages": [
    {
      "type": "search",
      "url": "https://xueqiu.com/stock/search.json?code=<keyword>&size=10",
      "notes": "JSON {stocks:[{code,name,exchange(SH/SZ/BJ/...),current,percentage}]};沪深北股票 symbol 需拼前缀,如 SH600519,详情页 https://xueqiu.com/S/<symbol>"
    }
  ],
  "recipes": ["xueqiu-search-stock"],
  "notes": "雪球登录态走 cookie。关键:必须先 navigate 到 https://xueqiu.com,再用 evaluate 步在页面内 fetch(接口全路径, {credentials:'include'})——直接 navigate 到 *.json 会被风控喂 SPA HTML 或拦截,且拿不到 cookie。已收录 xueqiu-search-stock(按代码/名称搜股票)。其它常用读端点同理在页面内 fetch:实时行情 stock.xueqiu.com/v5/stock/batch/quote.json?symbol=<SH600519|AAPL|00700>(响应 data.items[0].quote:current/chg/percent/open/high/low/last_close/volume/amount/market_capital);热门股票榜 stock.xueqiu.com/v5/stock/hot_stock/list.json?size=<n>&type=10(响应 data.items[{symbol,name,current,percent,value(热度)}]);热门动态 xueqiu.com/statuses/hot/listV3.json?source=hot&page=1(响应 list[{id,description(HTML,需去标签),user:{id,screen_name},fav_count,retweet_count,reply_count}],帖子 URL = https://xueqiu.com/<user.id>/<id>);首页时间线 xueqiu.com/v4/statuses/home_timeline.json?page=1&count=20(需登录,响应 home_timeline 或 list,结构同热门动态);自选股 stock.xueqiu.com/v5/stock/portfolio/stock/list.json?size=100&category=1&pid=-1(响应 data.stocks[{symbol,name,current,chg,percent}]);预计财报日 stock.xueqiu.com/v5/stock/screener/event/list.json?symbol=<SYMBOL>&page=1&size=100(响应 data.items,subtype===2 为预计财报发布,timestamp 毫秒)。沪深北 symbol 统一加 SH/SZ/BJ 前缀;港股用 5 位数代码;美股直接代码。"
},{
  "site": "youtube.com",
  "auth": "搜索/看视频元数据只读无需登录;个性化结果/订阅内容走持久浏览器登录态",
  "entry": {
    "home": "https://www.youtube.com",
    "results": "https://www.youtube.com/results?search_query=<kw>",
    "watch": "https://www.youtube.com/watch?v=<videoId>"
  },
  "recipes": ["youtube-search"],
  "notes": "YouTube 没有公开稳定的 JSON 搜索 API,但搜索结果会被写进页面全局变量 window.ytInitialData。youtube-search 配方先 navigate 到 https://www.youtube.com/results?search_query=<query>,wait load,再 evaluate 从 ytInitialData.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[].itemSectionRenderer.contents[].videoRenderer 取每条视频:title.runs[0].text、ownerText.runs[0].text(频道)、viewCountText.simpleText(播放量)、lengthText.simpleText(时长)、publishedTimeText.simpleText(发布时间)、videoId(拼 watch URL)。过滤可在 results URL 上加 &sp=<token>(type/upload/sort 的 protobuf token,一次只能用一个)。单个视频详情:navigate 到 watch 页后读 window.ytInitialPlayerResponse.videoDetails(title/author/viewCount/lengthSeconds/shortDescription/keywords)。频道信息走 innertube /youtubei/v1/browse(需从 window.ytcfg.data_ 取 INNERTUBE_API_KEY + INNERTUBE_CONTEXT 再 POST),较重,本配方不覆盖。注意:reelItemRenderer(Shorts)结构不同,本配方只取常规 videoRenderer。"
},{
  "site": "zhihu.com",
  "auth": "需要登录态:知乎 api 对未登录/异常会话返回非 JSON 或被风控,请在持久浏览器登录 zhihu.com 后使用",
  "entry": {
    "home": "https://www.zhihu.com",
    "searchV3": "https://www.zhihu.com/api/v4/search_v3?t=general&offset=0&limit=<limit>&q=<keyword>",
    "hotList": "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50"
  },
  "recipes": ["zhihu-search"],
  "notes": "关键:不要直接 navigate 到 api 路径——非同源访问会被风控喂 SPA HTML。正确姿势是先 navigate 到 https://www.zhihu.com,再用 evaluate 步在页面内 fetch(api 全路径, {credentials:'include'}):同源 + 带 cookie。zhihu-search 走 /api/v4/search_v3?t=general&offset=0&limit=<n>&q=<encodeURIComponent(keyword)>;响应 {data:[{type:'search_result', object:{type,title,excerpt,voteup_count,author:{name},id,question:{id,name}}}]},只取 type==='search_result' 的项。URL 拼接按 object.type:answer→/question/<qid>/answer/<id>,article→zhuanlan.zhihu.com/p/<id>,否则→/question/<id>。另有热榜接口 /api/v3/feed/topstory/hot-lists/total?limit=50(data[].target.{title,answer_count,follower_count},detail_text 是热度文案);⚠️ 热榜响应里 question id 是 16+ 位大整数,JSON.parse 会丢精度,需先把 \"id\":<digits> 用正则替换成字符串再 parse,本配方未收录热榜正因这层处理较脆,需要时照此注意。务必使用持久浏览器(带登录态)。"
}];
