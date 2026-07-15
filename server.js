const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 💡 한국 시간(KST) 기준 오늘 날짜 구하기 (예: "2026-07-15")
const getKSTDate = () => {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const kst = new Date(utc + (9 * 3600000));
  return kst.toISOString().split('T')[0]; 
};

// [API 1] 라이선스 검증
app.post("/api/verify", async (req, res) => {
  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ error: "키가 없습니다." });
  try {
    const { data: license, error } = await supabase.from("licenses").select("*").eq("license_key", licenseKey).single();
    if (error || !license) return res.status(401).json({ error: "유효하지 않은 키" });

    // 날짜가 다르면 사용량을 0으로 보여줌
    let used = license.used_chars || 0;
    if (license.last_reset_date !== getKSTDate()) used = 0; 

    return res.json({ success: true, limit: license.daily_limit, used, role: license.role || 'user' });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// [API 2] 앙상블 탐지 및 자동 리셋
app.post("/api/detect", async (req, res) => {
  const { text, licenseKey } = req.body;
  try {
    const { data: license } = await supabase.from("licenses").select("*").eq("license_key", licenseKey).single();
    if (!license) return res.status(401).json({ error: "유효하지 않은 키" });

    const today = getKSTDate();
    let used = license.used_chars || 0;

    // 💡 날짜가 바뀌었으면 사용량을 0으로 강제 초기화
    if (license.last_reset_date !== today) {
      used = 0;
    }

    if (license.role !== "admin" && (used + text.length > license.daily_limit)) {
      return res.status(403).json({ error: "일일 한도 초과" });
    }

    const prompt = `당신은 언어 통계학자입니다. 텍스트의 Perplexity(혼란도)와 Burstiness(변칙성)를 분석하여 AI 작성 확률(0-100)을 산출하십시오. 숫자 하나만 출력하십시오. 텍스트: """${text}"""`;

    // Gemini 3.5 & Groq 앙상블
    const [geminiRes, groqRes] = await Promise.all([
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } })
      }).then(r => r.json()),
      
      fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], temperature: 0 })
      }).then(r => r.json())
    ]);

    const geminiScore = parseInt(geminiRes.candidates[0].content.parts[0].text.replace(/[^0-9]/g, '')) || 0;
    const groqScore = parseInt(groqRes.choices[0].message.content.replace(/[^0-9]/g, '')) || 0;
    const finalScore = Math.round((geminiScore + groqScore) / 2);

    // 💡 DB 업데이트: 글자수 증가 + 오늘 날짜로 갱신
    await supabase.from("licenses").update({ 
      used_chars: used + text.length,
      last_reset_date: today 
    }).eq("license_key", licenseKey);

    return res.json({ success: true, aiScore: finalScore, updatedUsed: used + text.length });
  } catch (err) {
    return res.status(500).json({ error: "탐지 서버 오류" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server Active"));
