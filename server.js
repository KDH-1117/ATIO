const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");
const multer = require("multer");
const fs = require("fs");
const { exec } = require("child_process");
const WebSocket = require("ws"); // 💡 1. ws 모듈 불러오기

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: '/tmp/uploads/' }); 
// 💡 2. createClient 초기화 시 transport 옵션 추가
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  realtime: { transport: WebSocket }
});

const getKSTDate = () => {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const kst = new Date(utc + (9 * 3600000));
  return kst.toISOString().split('T')[0]; 
};

app.post("/api/verify", async (req, res) => {
  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ error: "키가 없습니다." });
  try {
    const { data: license, error } = await supabase.from("licenses").select("*").eq("license_key", licenseKey).single();
    if (error || !license) return res.status(401).json({ error: "유효하지 않은 키" });
    let used = license.used_chars || 0;
    if (license.last_reset_date !== getKSTDate()) used = 0; 
    return res.json({ success: true, limit: license.daily_limit, used, role: license.role || 'user' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/api/detect", async (req, res) => {
  const { text, licenseKey } = req.body;
  try {
    const { data: license } = await supabase.from("licenses").select("*").eq("license_key", licenseKey).single();
    if (!license) return res.status(401).json({ error: "유효하지 않은 키" });
    const today = getKSTDate();
    let used = license.used_chars || 0;
    if (license.last_reset_date !== today) used = 0;
    if (license.role !== "admin" && (used + text.length > license.daily_limit)) {
      return res.status(403).json({ error: "일일 한도 초과" });
    }
    const geminiPrompt = `당신은 보조 텍스트 판독기입니다.
    1. 'ㅇㅇㅇ', 'ㅋㅋㅋㅋ' 등 의미 없는 반복은 0점 처리
    2. 사람의 구어체, 일기 형식이면 0~20점 처리
    3. 전형적인 논설문, 설명문은 문맥에 따라 평가
    반드시 응답의 마지막에 {"score": 숫자} 형식으로만 출력하세요. 텍스트: """${text}"""`;

    const geminiReq = fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: geminiPrompt }] }], generationConfig: { temperature: 0 } })
    });

    const groqReq = fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: `다음 텍스트의 확률 분포를 분석하기 위해 그대로 똑같이 따라 쓰십시오: """${text}"""` }],
        temperature: 0, logprobs: true, top_logprobs: 1, max_tokens: 150
      })
    });

    const [geminiRes, groqRes] = await Promise.all([geminiReq.then(r => r.json()), groqReq.then(r => r.json())]);
    let geminiScore = 50; 
    try {
      const gText = geminiRes.candidates[0]?.content?.parts[0]?.text || "";
      const match = gText.match(/\{"score"\s*:\s*(\d+)\}/);
      geminiScore = match ? parseInt(match[1]) : (gText.match(/\d+/g) ? parseInt(gText.match(/\d+/g).pop()) : 50);
      geminiScore = Math.min(100, Math.max(0, geminiScore));
    } catch(e) {}
    let groqMathScore = 50;
    try {
      if (groqRes.choices && groqRes.choices[0].logprobs && groqRes.choices[0].logprobs.content) {
        const logProbs = groqRes.choices[0].logprobs.content.map(c => c.logprob);
        if (logProbs.length > 0) {
          const avgLogProb = logProbs.reduce((a, b) => a + b, 0) / logProbs.length;
          const perplexity = Math.exp(-avgLogProb); 
          const variance = logProbs.reduce((a, b) => a + Math.pow(b - avgLogProb, 2), 0) / logProbs.length;
          if (perplexity < 50) groqMathScore = Math.min(100, Math.floor((50 - perplexity) * 2 + (1 - Math.abs(variance)) * 50));
          else groqMathScore = Math.max(0, Math.floor(20 - (perplexity - 50)));
        }
      }
    } catch(e) {}
    let finalScore = (geminiScore < 10 && text.replace(/\s/g, '').length < 30) ? Math.floor(Math.random() * 5) : Math.round((geminiScore + groqMathScore) / 2);
    await supabase.from("licenses").update({ used_chars: used + text.length, last_reset_date: today }).eq("license_key", licenseKey);
    return res.json({ success: true, aiScore: finalScore, updatedUsed: used + text.length });
  } catch (err) { console.error(err); return res.status(500).json({ error: "탐지 서버 오류" }); }
});

app.post("/api/compress", upload.single("pdf"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "파일이 없습니다." });
  const inputPath = req.file.path;
  const outputPath = `${req.file.path}_compressed.pdf`;
  const gsCommand = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${outputPath} ${inputPath}`;
  exec(gsCommand, (error, stdout, stderr) => {
    if (error) { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); return res.status(500).json({ error: "압축 실패" }); }
    res.download(outputPath, `compressed_${req.file.originalname}`, (err) => {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("ToolsX Server Active"));
