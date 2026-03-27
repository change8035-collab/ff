import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: '5mb' }));
// 쿠키 파싱
app.use((req, _res, next) => {
  req.cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, v] = c.trim().split('=');
    if (k) req.cookies[k] = v;
  });
  next();
});

// 비밀번호 보호
const ACCESS_PW = process.env.ACCESS_PW || '';
if (ACCESS_PW) {
  app.use((req, res, next) => {
    if (req.path === '/api/login') return next();
    if (req.cookies?.auth === ACCESS_PW || req.headers['x-auth'] === ACCESS_PW) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '인증 필요' });
    // 로그인 페이지 제공
    res.send(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Login</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0f0f23;color:#e0e0e0;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#1a1a2e;padding:40px;border-radius:16px;border:1px solid #2a2a4a;text-align:center;max-width:360px;width:90%}
h1{font-size:1.5rem;background:linear-gradient(135deg,#ff6b6b,#ffa500);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:20px}
input{width:100%;padding:12px 16px;background:#0f0f23;border:1px solid #3a3a5a;border-radius:10px;color:#e0e0e0;font-size:1rem;outline:none;margin-bottom:12px}
input:focus{border-color:#ffa500}
button{width:100%;padding:12px;background:linear-gradient(135deg,#ff6b6b,#ffa500);color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:600;cursor:pointer}
.err{color:#ff6b6b;font-size:0.85rem;margin-top:8px;display:none}</style></head><body>
<div class="box"><h1>YT Rewriter</h1><input type="password" id="pw" placeholder="비밀번호" autofocus>
<button onclick="login()">입장</button><div class="err" id="err">비밀번호가 틀렸습니다</div></div>
<script>
document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
async function login(){const pw=document.getElementById('pw').value;const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pw})});
if(r.ok){document.cookie='auth='+pw+';path=/;max-age=31536000;SameSite=Strict';location.reload()}else{document.getElementById('err').style.display='block'}}</script></body></html>`);
  });
  app.post('/api/login', (req, res) => {
    if (req.body.pw === ACCESS_PW) return res.json({ ok: true });
    res.status(401).json({ error: '비밀번호 오류' });
  });
}

app.use(express.static(join(__dirname, 'public')));

// YouTube 비디오 ID 추출
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^&\s]+)/,
    /(?:youtu\.be\/)([^?\s]+)/,
    /(?:youtube\.com\/embed\/)([^?\s]+)/,
    /(?:youtube\.com\/shorts\/)([^?\s]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// YouTube 자막 직접 추출
async function fetchTranscript(videoId) {
  const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // 방법 1: InnerTube API (Android client)
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `com.google.android.youtube/20.10.38 (Linux; U; Android 14)`,
      },
      body: JSON.stringify({
        context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
        videoId,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks) && tracks.length > 0) {
        // 한국어 우선
        const koTrack = tracks.find(t => t.languageCode === 'ko');
        const track = koTrack || tracks[0];
        const transcript = await fetchCaptionTrack(track.baseUrl, USER_AGENT);
        if (transcript) return transcript;
      }
    }
  } catch (e) {
    // 방법 2로 폴백
  }

  // 방법 2: 웹 페이지에서 추출
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  const html = await pageRes.text();

  if (html.includes('class="g-recaptcha"')) {
    throw new Error('YouTube에서 CAPTCHA를 요청합니다. 잠시 후 다시 시도해주세요.');
  }

  // ytInitialPlayerResponse에서 자막 트랙 추출
  const match = html.match(/var ytInitialPlayerResponse = ({.+?});/);
  if (!match) throw new Error('영상 정보를 가져올 수 없습니다.');

  let playerResponse;
  try { playerResponse = JSON.parse(match[1]); } catch { throw new Error('영상 데이터 파싱 실패'); }

  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error('이 영상에는 자막이 없습니다.');
  }

  const koTrack = tracks.find(t => t.languageCode === 'ko');
  const track = koTrack || tracks[0];
  const transcript = await fetchCaptionTrack(track.baseUrl, USER_AGENT);
  if (!transcript) throw new Error('자막 데이터를 가져올 수 없습니다.');
  return transcript;
}

// 자막 트랙 URL에서 텍스트 추출
async function fetchCaptionTrack(baseUrl, userAgent) {
  try {
    const url = new URL(baseUrl);
    if (!url.hostname.endsWith('.youtube.com')) return null;
  } catch { return null; }

  const res = await fetch(baseUrl, {
    headers: { 'User-Agent': userAgent },
  });
  if (!res.ok) return null;

  const xml = await res.text();

  // XML에서 텍스트 추출 (두 가지 형식 지원)
  const texts = [];

  // 형식 1: <p t="..." d="...">...</p>
  const pRegex = /<p\s+t="\d+"\s+d="\d+"[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRegex.exec(xml)) !== null) {
    let text = m[1].replace(/<[^>]+>/g, '');
    text = decodeEntities(text).trim();
    if (text) texts.push(text);
  }

  // 형식 2: <text start="..." dur="...">...</text>
  if (texts.length === 0) {
    const textRegex = /<text start="[^"]*" dur="[^"]*">([^<]*)<\/text>/g;
    while ((m = textRegex.exec(xml)) !== null) {
      const text = decodeEntities(m[1]).trim();
      if (text) texts.push(text);
    }
  }

  return texts.length > 0 ? texts.join(' ') : null;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

// 자막 추출 API
app.post('/api/transcript', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL을 입력해주세요.' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: '유효한 유튜브 URL이 아닙니다.' });
    }

    const transcript = await fetchTranscript(videoId);
    res.json({ videoId, transcript });
  } catch (err) {
    console.error('Transcript error:', err.message);
    res.status(500).json({ error: err.message || '자막을 가져올 수 없습니다.' });
  }
});

// 리라이팅 API
app.post('/api/rewrite', async (req, res) => {
  try {
    const { transcript, apiKey } = req.body;
    if (!transcript || !apiKey) {
      return res.status(400).json({ error: '대본과 API 키가 필요합니다.' });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        maxOutputTokens: 65536,
        temperature: 0.9,
      },
    });

    const charCount = transcript.length;

    const prompt = `당신은 전문 콘텐츠 리스키닝 전문가입니다. 다음 유튜브 영상 대본의 스토리 구조와 전개를 100% 유지하되, 등장인물의 설정(성별, 나이, 직업 등)을 변경하여 저작권에 걸리지 않는 새로운 대본을 만들어주세요.

## 절대 규칙: 분량 유지
- 원본 대본은 약 ${charCount.toLocaleString()}자입니다.
- 리라이팅 결과도 반드시 원본과 비슷한 분량(±10%)을 유지해야 합니다.
- 절대로 요약하거나 축약하지 마세요. 원본의 모든 내용, 예시, 설명, 에피소드를 빠짐없이 포함해야 합니다.
- 내용을 생략하지 말고, 오히려 자연스러운 연결어나 부연 설명을 추가하여 분량을 맞추세요.

## 리스키닝 핵심 규칙 (반드시 준수)
1. **스토리 구조 100% 유지**: 사건의 순서, 갈등 구조, 감정선, 전환점, 클라이맥스를 원본과 동일하게 가져갑니다.
2. **인물 설정 변경**: 등장인물의 성별, 나이, 직업, 이름을 바꿉니다. (예: 30대 남성 회사원 → 50대 여성 자영업자)
3. **배경/소재 변경**: 구체적인 장소, 업종, 분야 등을 원본과 다르게 설정합니다. 단, 스토리 전개에 영향을 주지 않는 범위에서 변경합니다.
4. **핵심 메시지 유지**: 원본이 전달하려는 교훈, 감동, 정보는 그대로 유지합니다.
5. **분량 1:1 대응**: 원본의 각 단락/장면마다 대응하는 내용이 반드시 있어야 합니다. 어떤 장면도 빠뜨리지 마세요.

## 추가 규칙
- 원본과 동일한 문장이 3어절 이상 연속되지 않도록 합니다
- 문체와 어투를 자연스럽게 변경합니다
- 변경된 인물 설정이 스토리 전체에서 일관되게 유지되어야 합니다
- 자연스러운 한국어로 작성합니다

## 원본 대본
${transcript}

## 출력 형식
리스키닝된 대본만 출력해주세요. 설명이나 주석 없이 대본 텍스트만 작성합니다. 반드시 원본과 동일한 분량을 유지하세요.`;

    const result = await model.generateContentStream(prompt);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Rewrite error:', err.message);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      return res.end();
    }
    if (err.message.includes('API_KEY_INVALID') || err.message.includes('API key')) {
      return res.status(401).json({ error: 'API 키가 유효하지 않습니다. 확인 후 다시 시도해주세요.' });
    }
    res.status(500).json({ error: '리라이팅 중 오류가 발생했습니다: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
