const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.post("/api/detect", async (req, res) => {
  const { text, licenseKey } = req.body;
  if (!text || !licenseKey) return res.status(400).json({ error: "데이터 누락" });

  try {
    const { data: license } = await supabase.from("licenses").select("*").eq("license_key", licenseKey).single();
    if (!license) return res.status(401).json({ error: "Invalid Key" });

    // 통계 분석용 프롬프트
    const prompt = `당신은 언어 통계학자입니다. 텍스트를 분석하여 AI 작성 확률(0-100)을 산출하십시오.
    [기준: Perplexity(혼란도)와 Burstiness(변칙성) 분석]
    설명 생략, 오직 0-100 사이의 숫자 하나만 출력하십시오.
    텍스트: """${text}"""`;

    // 1. Gemini 3.5 Flash & Groq Llama 3.3 동시 호출
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

    // 2. 결과 파싱 및 평균 계산
    const geminiScore = parseInt(geminiRes.candidates[0].content.parts[0].text.replace(/[^0-9]/g, '')) || 0;
    const groqScore = parseInt(groqRes.choices[0].message.content.replace(/[^0-9]/g, '')) || 0;
    
    const finalScore = Math.round((geminiScore + groqScore) / 2);

    await supabase.from("licenses").update({ used_chars: license.used_chars + text.length }).eq("license_key", licenseKey);
    
    return res.json({ success: true, aiScore: finalScore });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "탐지 실패" });
  }
});

app.listen(3000, () => console.log("Ensemble Server Running"));
