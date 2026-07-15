const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

    // --- 엔진 1. Gemini: 문맥 파악 및 스팸(테러) 방어 프롬프트 ---
    const geminiPrompt = `당신은 보조 텍스트 판독기입니다.
    1. 'ㅇㅇㅇ', 'ㅋㅋㅋㅋ' 등 의미 없는 반복은 0점 처리
    2. 사람의 구어체, 일기 형식이면 0~20점 처리
    3. 전형적인 논설문, 설명문은 문맥에 따라 평가
    반드시 응답의 마지막에 {"score": 숫자} 형식으로만 출력하세요. 텍스트: """${text}"""`;

    const geminiReq = fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: geminiPrompt }] }], generationConfig: { temperature: 0 } })
    });

    // --- 엔진 2. Groq (Llama): 논문 기반 '로그 확률(Logprobs)' 수학 공식 적용 ---
    const groqReq = fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: `다음 텍스트의 확률 분포를 분석하기 위해 그대로 똑같이 따라 쓰십시오: """${text}"""` }],
        temperature: 0,
        logprobs: true,         // 💡 핵심: API가 내뱉는 각 단어의 수학적 확률 데이터를 받아옴
        top_logprobs: 1,
        max_tokens: 150
      })
    });

    const [geminiRes, groqRes] = await Promise.all([geminiReq.then(r => r.json()), groqReq.then(r => r.json())]);

    // 1. Gemini 문맥 점수 추출
    let geminiScore = 50; 
    try {
      const gText = geminiRes.candidates[0]?.content?.parts[0]?.text || "";
      const match = gText.match(/\{"score"\s*:\s*(\d+)\}/);
      geminiScore = match ? parseInt(match[1]) : (gText.match(/\d+/g) ? parseInt(gText.match(/\d+/g).pop()) : 50);
      geminiScore = Math.min(100, Math.max(0, geminiScore));
    } catch(e) {}

    // 2. Groq 수식 점수 추출 (PPL 및 Variance 직접 계산)
    let groqMathScore = 50;
    try {
      if (groqRes.choices && groqRes.choices[0].logprobs && groqRes.choices[0].logprobs.content) {
        const logProbs = groqRes.choices[0].logprobs.content.map(c => c.logprob);
        
        if (logProbs.length > 0) {
          // 💡 논문 공식: 평균 로그 확률 산출 -> Perplexity(혼란도) -> Variance(분산) 계산
          const avgLogProb = logProbs.reduce((a, b) => a + b, 0) / logProbs.length;
          const perplexity = Math.exp(-avgLogProb); 
          const variance = logProbs.reduce((a, b) => a + Math.pow(b - avgLogProb, 2), 0) / logProbs.length;

          if (perplexity < 50) {
            // PPL이 낮고(예측 가능), 분산이 적을수록(일정한 문장 구조) AI 점수 상승
            groqMathScore = Math.min(100, Math.floor((50 - perplexity) * 2 + (1 - Math.abs(variance)) * 50));
          } else {
            groqMathScore = Math.max(0, Math.floor(20 - (perplexity - 50)));
          }
        }
      }
    } catch(e) {}

    // 3. 최종 점수 결합 (스팸 글 차단 로직 포함)
    let finalScore = 0;
    if (geminiScore < 10 && text.replace(/\s/g, '').length < 30) {
      // 'ㅇㅇㅇ' 같은 짧은 테러/스팸 글은 수식이 튀어도 무조건 0~5% 내외로 방어
      finalScore = Math.floor(Math.random() * 5); 
    } else {
      // 정상 텍스트는 수식 점수와 문맥 점수의 평균으로 도출
      finalScore = Math.round((geminiScore + groqMathScore) / 2);
    }

    await supabase.from("licenses").update({ used_chars: used + text.length, last_reset_date: today }).eq("license_key", licenseKey);
    return res.json({ success: true, aiScore: finalScore, updatedUsed: used + text.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "탐지 서버 오류" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Mathematical Logic Server Active"));
