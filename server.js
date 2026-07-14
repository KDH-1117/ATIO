const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

// Supabase 연결
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// [API 1] 라이선스 검증
app.post("/api/verify", async (req, res) => {
  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ error: "라이선스 키가 필요합니다." });

  try {
    const { data: license, error } = await supabase
      .from("licenses")
      .select("*")
      .eq("license_key", licenseKey)
      .single();

    if (error || !license) return res.status(401).json({ error: "유효하지 않은 라이선스 키입니다." });

    return res.json({ 
      success: true, 
      limit: license.daily_limit, 
      used: license.used_chars || 0,
      role: license.role || 'user' 
    });
  } catch (err) {
    return res.status(500).json({ error: "서버 연결 오류" });
  }
});

// [API 2] AI 텍스트 검사 (Gemini & Groq 전용)
app.post("/api/detect", async (req, res) => {
  const { text, licenseKey, model } = req.body;
  if (!text || !licenseKey || !model) return res.status(400).json({ error: "필수 데이터 누락" });

  const charCount = text.length;

  try {
    const { data: license, error } = await supabase.from("licenses").select("*").eq("license_key", licenseKey).single();
    if (error || !license) return res.status(401).json({ error: "유효하지 않은 키입니다." });

    const limit = license.daily_limit;
    const used = license.used_chars || 0;
    const role = license.role || 'user';

    // 🚨 한도 차감 제어: 어드민이 아닐 때만 글자 수 초과 검사
    if (role !== "admin" && (used + charCount > limit)) {
      return res.status(403).json({ error: "일일 글자 수 한도가 초과되었습니다." });
    }

    let aiScore = 0;

    // 수학적 기준(Perplexity, Burstiness)을 주입하여 정확도를 극대화한 프롬프트
    const prompt = `당신은 세계 최고 수준의 AI 텍스트 탐지 전문가입니다. 아래 한국어 텍스트를 분석하여 AI(ChatGPT, Claude 등)가 작성했을 확률을 0부터 100 사이의 정수(%)로 평가하세요.
    
    [채점 기준]
    1. 혼란도(Perplexity): 단어 선택이 예측 가능하고 판에 박힌 어휘인가? (AI 확률 증가) 아니면 창의적이고 예상 밖의 어휘가 섞여 있는가? (사람 확률 증가)
    2. 변칙성(Burstiness): 문장의 길이가 일정하고 호흡이 비슷한가? (AI 확률 증가) 아니면 아주 짧은 문장과 긴 문장이 불규칙하게 섞여 있는가? (사람 확률 증가)
    3. 구조적 특징: '첫째, 둘째', '결론적으로' 등 지나치게 정돈된 서론-본론-결론 구조를 가지는가? (AI 확률 증가)

    위 기준을 엄격하게 적용하여 오직 0에서 100 사이의 숫자 하나만 출력하세요. 설명, 기호(%) 등 다른 텍스트는 절대 포함하지 마세요.
    텍스트: """${text}"""`;

    // 1. Google Gemini
    if (model === "gemini") {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const result = await response.json();
      if (result.error) return res.status(400).json({ error: `Gemini 오류: ${result.error.message}` });
      aiScore = parseInt(result.candidates[0].content.parts[0].text.replace(/[^0-9]/g, '')) || 0;
    } 
    // 2. Groq Llama 3
    else if (model === "groq") {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama3-70b-8192", messages: [{ role: "user", content: prompt }] })
      });
      const result = await response.json();
      if (result.error) return res.status(400).json({ error: `Groq 오류: ${result.error.message}` });
      aiScore = parseInt(result.choices[0].message.content.replace(/[^0-9]/g, '')) || 0;
    }

    aiScore = Math.min(100, Math.max(0, aiScore)); 
    
    // 검사 성공 시 DB 사용량 업데이트 (어드민이든 유저든 누적 사용량은 기록함)
    await supabase.from("licenses").update({ used_chars: used + charCount }).eq("license_key", licenseKey);
    return res.json({ success: true, aiScore, usedChars: used + charCount, dailyLimit: limit });

  } catch (err) {
    return res.status(500).json({ error: "서버 내부 처리 중 오류가 발생했습니다." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 작동 중 (포트 ${PORT})`));
