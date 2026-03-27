import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: '5mb' }));

// 쿠키 파싱 미들웨어
app.use((req, _res, next) => {
  req.cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, v] = c.trim().split('=');
    if (k) req.cookies[k] = v;
  });
  next();
});

// 비밀번호 보호 로직
const ACCESS_PW = process.env.ACCESS_PW || '';
if (ACCESS_PW) {
  app.use((req, res, next) => {
    if (req.path === '/api/login') return next();
    if (req.cookies?.auth === ACCESS_PW || req.headers['x-auth'] === ACCESS_PW) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '인증 필요' });
    
    // 로그인 페이지 HTML
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

// 정적 파일 제공 (public 폴더)
app.use(express.static(join(__dirname, 'public')));

// YouTube 관련 함수들 (동일)
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

async function fetchTranscript(videoId) {
  const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
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
        const koTrack = tracks.find(t => t.languageCode === 'ko');
        const track = koTrack || tracks[0];
        const transcript = await fetchCaptionTrack(track.baseUrl, USER_AGENT);
        if (transcript) return transcript;
      }
    }
  } catch (e) {}

  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: { 'User-Agent': USER_AGENT } });
  const html = await pageRes.text();
  if (html.includes('class="g-recaptcha"')) throw new Error('YouTube CAPTCHA 발생');
  const match = html.match(/var ytInitialPlayerResponse = ({.+?});/);
  if (!match) throw new Error('영상 정보를 가져올 수 없습니다.');
  let playerResponse = JSON.parse(match[1]);
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) throw new Error('자막이 없습니다.');
  const koTrack = tracks.find(t => t.languageCode === 'ko');
  const track = koTrack || tracks[0];
  return await fetchCaptionTrack(track.baseUrl, USER_AGENT);
}

async function fetchCaptionTrack(baseUrl, userAgent) {
  const res = await fetch(baseUrl, { headers: { 'User-Agent': userAgent } });
  const xml = await res.text();
  const texts = [];
  const pRegex = /<p\s+t="\d+"\s+d="\d+"[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRegex.exec(xml)) !== null) {
    let text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text) texts.push(decodeEntities(text));
  }
  return texts.length > 0 ? texts.join(' ') : null;
}

function decodeEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// API 엔드포인트
app.post('/api/transcript', async (req, res) => {
  try {
    const { url } = req.body;
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'URL 오류' });
    const transcript = await fetchTranscript(videoId);
    res.json({ videoId, transcript });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rewrite', async (req, res) => {
  try {
    const { transcript, apiKey } = req.body;
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }); // 2.5-flash 에러 방지를 위해 1.5로 수정 제안
    const result = await model.generateContentStream(`유튜브 대본 리라이팅: ${transcript}`);
    
    res.setHeader('Content-Type', 'text/event-stream');
    for await (const chunk of result.stream) {
      res.write(`data: ${JSON.stringify({ text: chunk.text() })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vercel 환경을 위한 설정
export default app;
