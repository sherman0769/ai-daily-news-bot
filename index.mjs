// index.mjs — Li's Meet AI 快訊 Bot（RSS → Gemini → LINE）
// 功能重點：
// 1) 近 24 小時 RSS 聚合（含 UA/逾時、防 404 替代來源）
// 2) 過濾「單篇文章 URL」、去除搜尋/首頁/示範網址
// 3) 嚴格輸出格式：表情序列號、每條 20–30 字、每條之間空一行、完整 URL
// 4) 禁止杜撰：只允許使用候選新聞清單

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import Parser from 'rss-parser';

const FEEDS = [
  // 英文主流/AI
  'https://www.theverge.com/rss/index.xml',
  'https://techcrunch.com/tag/artificial-intelligence/feed/',
  'https://www.cnbc.com/id/19854910/device/rss/rss.html',        // CNBC Tech
  'https://www.theguardian.com/uk/technology/rss',                // Guardian Tech
  'https://feeds.arstechnica.com/arstechnica/index',              // Ars Technica
  'https://www.technologyreview.com/feed/',                       // MIT Tech Review  
  'https://www.zdnet.com/topic/artificial-intelligence/rss.xml',  // ZDNet AI
  // 中文
  'https://www.ithome.com.tw/rss',                                // iThome
  'https://technews.tw/feed/'                                     // 科技新報
];

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const GEMINI_RETRY_DELAYS_MS = [5000, 15000, 30000];
const RETRYABLE_GEMINI_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorSummary(e) {
  const status = e?.status ?? e?.statusCode ?? e?.code ?? e?.response?.status;
  const message = e?.message || String(e);
  return status ? `${status} ${message}` : message;
}

function isRetryableGeminiError(e) {
  const status = e?.status ?? e?.statusCode ?? e?.code ?? e?.response?.status;
  const numericStatus = typeof status === 'string' ? Number(status) : status;
  const message = e?.message || String(e);

  return RETRYABLE_GEMINI_STATUS_CODES.has(numericStatus)
    || /high demand|UNAVAILABLE|temporarily unavailable/i.test(message);
}

function buildGeminiFallbackPost(dateStr = twDateStr()) {
  return `🌟 Li's Meet AI Studio每日重要快訊｜${dateStr} 🌟

今日 AI 新聞整理服務暫時忙碌，系統稍後將恢復。請稍後再查看。`;
}

async function generateContentWithRetry(ai, request) {
  for (let attempt = 0; attempt <= GEMINI_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (e) {
      const canRetry = isRetryableGeminiError(e);
      if (!canRetry || attempt === GEMINI_RETRY_DELAYS_MS.length) {
        throw e;
      }

      const delayMs = GEMINI_RETRY_DELAYS_MS[attempt];
      console.warn(
        `Gemini 暫時失敗，準備第 ${attempt + 1}/${GEMINI_RETRY_DELAYS_MS.length} 次重試，等待 ${delayMs / 1000} 秒：${getErrorSummary(e)}`
      );
      await sleep(delayMs);
    }
  }
}

// —— 台灣日期字串
function twDateStr(d = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const y = parts.find(p=>p.type==='year').value;
  const m = parts.find(p=>p.type==='month').value;
  const dd= parts.find(p=>p.type==='day').value;
  return `${y}年${m}月${dd}日`;
}

// —— URL 品質把關：拒絕搜尋/首頁/示範網址，只要「像單篇文章」的路徑
function isGoodUrl(u) {
  try {
    const url = new URL(u);
    const badHosts = new Set(['google.com', 'www.google.com', 'example.org', 'example.com']);
    if (badHosts.has(url.hostname)) return false;
    // 需要像文章頁路徑（日期或 slug），避免根目錄/搜尋結果
    return /\/\d{4}\/\d{2}\/\d{2}\/|\/\d+\/|[-_]{1}[a-z0-9]|[a-z][a-z0-9-]{10,}/i.test(url.pathname);
  } catch { return false; }
}

// —— 抓 24h 內候選新聞，關鍵字粗過濾 + 去重
async function fetchNewsLast24h() {
  const parser = new Parser({
    requestOptions: {
      headers: {
        'User-Agent': 'LisMeet-AI-NewsBot/1.0 (+https://lis-meet-ai-63bj7nm.gamma.site)'
      },
      timeout: 12000
    }
  });

  const now = new Date();
  const since = new Date(now.getTime() - 24*60*60*1000);
  const items = [];

  for (const url of FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      for (const it of feed.items || []) {
        const link = (it.link || it.guid || '').trim();
        const pub = it.isoDate ? new Date(it.isoDate)
                : it.pubDate ? new Date(it.pubDate)
                : null;
        if (!link || !pub || isNaN(pub)) continue;
        if (pub < since) continue;

        const title = (it.title || '').trim();
        items.push({ title, link, pub, source: (feed.title || '').trim() });
      }
    } catch (e) {
      console.warn('RSS 讀取失敗：', url, e.message);
    }
  }

  // 去重（標題+連結），並過濾 AI 相關與「可用」URL
  const seen = new Set();
  const aiRegex = /\b(ai|人工智慧|人工智能|gemini|openai|meta|微軟|microsoft|google|nvidia|輝達|llm|大語言模型|生成式)\b/i;

  const uniq = [];
  for (const it of items.sort((a,b)=>b.pub - a.pub)) {
    const key = (it.title + '|' + it.link).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!aiRegex.test(it.title)) continue;
    if (!isGoodUrl(it.link)) continue;
    uniq.push(it);
  }
  return uniq.slice(0, 20); // 候選 20 條，交給模型挑 5–8
}

async function buildPost(items) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('缺少 GEMINI_API_KEY');

  const ai = new GoogleGenAI({ apiKey });

  const dateStr = twDateStr();
  const candidates = items.map((it, i) =>
    `${i+1}. ${it.title}\n來源：${it.link}`).join('\n');

  const prompt = [{
    role: "user",
    parts: [{
      text: `
你是 AI 新聞編輯。從候選新聞中挑「5到8條」真正重要、與 AI 強相關的消息，
用「繁體中文」輸出每日快訊。嚴格遵守【格式】與【規則】，不得杜撰。

【候選新聞（近24小時，請僅從此清單擇要）】
${candidates}

【格式（嚴格遵守）】
🌟 Li's Meet AI Studio每日重要快訊｜${dateStr} 🌟

1️⃣ 【關鍵詞】一句摘要（20~30字，精準描述新進展/影響）
來源：完整URL

2️⃣ 【關鍵詞】一句摘要（20~30字）
來源：完整URL

…（共5~8條；每條之間「空一行」）

【規則】
- 只使用「候選新聞」清單；不得加入清單外內容、不得臆測。
- 每條 20–30 字；一個句子完成；不要分號或兩句併在一起。
- 表頭使用 1️⃣ 2️⃣ 3️⃣… 這類表情序列號。
- 【關鍵詞】為 2~6 字，可用：大型模型 AI法規 晶片 產品更新 投融資 安全治理 等。
- 來源必須是該條「單篇文章的完整 URL」，不得使用首頁/搜尋/示範網址；保留原始 URL，不要超連結語法。
- 僅輸出純文字，保留空一行的版面；不要多餘前言或附註。
`.trim()
    }]
  }];

  const resp = await generateContentWithRetry(ai, {
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  const text = resp.text?.trim();
  if (!text) throw new Error('Gemini 無內容回傳');
  return text.trim();
}

async function pushToLine(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const groupId = process.env.LINE_GROUP_ID;
  if (!token || !groupId) throw new Error('缺少 LINE_CHANNEL_ACCESS_TOKEN 或 LINE_GROUP_ID');

  const res = await fetch(LINE_PUSH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({ to: groupId, messages: [{ type: 'text', text }] })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LINE Push 失敗：${res.status} ${errText}`);
  }
}

(async () => {
  try {
    const items = await fetchNewsLast24h();

    if (items.length === 0) {
      await pushToLine(`🌟 Li's Meet AI Studio每日重要快訊｜${twDateStr()} 🌟

（目前無法取得近24小時 AI 新聞，請稍後再試）`);
      console.log('已送出備援訊息（無候選新聞）');
      return;
    }

    let post;
    try {
      post = await buildPost(items);
    } catch (e) {
      if (!isRetryableGeminiError(e)) {
        throw e;
      }

      console.error('Gemini 重試後仍暫時失敗，改送 LINE 備援訊息：', getErrorSummary(e));
      post = buildGeminiFallbackPost();
    }

    await pushToLine(post);
    console.log('✅ 已推送到群組');
  } catch (e) {
    console.error('❌ 執行失敗：', e);
    process.exit(1);
  }
})();
