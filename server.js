const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 라이선스 검증 기능
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

    return res.json({ success: true, limit: license.daily_limit, used: license.used_chars || 0 });
  } catch (err) {
    return res.status(500).json({ error: "서버 에러가 발생했습니다." });
  }
});

// AI 검사 기능 (에러 처리 완벽 수정)
app.post("/api/detect", async (req, res) => {
  const { text, licenseKey, model } = req.body;

  if (!text || !licenseKey || !model) {
    return res.status(400).json({ error: "텍스트, 라이선스 키, 모델 선택이 필요합니다." });
  }

  const charCount = text.length;

  try {
    const { data: license, error } = await supabase
      .from("licenses")
      .select("*")
      .eq("license_key", licenseKey)
      .single();

    if (error || !license) return res.status(401).json({ error: "유효하지 않은 라이선스 키입니다." });

    const limit = license.daily_limit;
    const used = license.used_chars || 0;

    if (used + charCount > limit) {
      return res.status(403).json({ error: "일일 글자 수 한도가 초과되었습니다." });
    }

    let aiScore = 0;

    if (model === "sapling") {
      const response = await fetch("https://api.sapling.ai/api/v1/aidetect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: process.env.SAPLING_API_KEY,
          text: text
        })
      });
      const result = await response.json();

      // [핵심 수정] Sapling에서 에러를 뱉으면 0%로 무시하지 않고 프론트로 에러 전달
      if (!response.ok || result.error || result.msg) {
         return res.status(400).json({ error: `Sapling 오류: ${result.error || result.msg || response.statusText}` });
      }
      aiScore = Math.round((result.score || 0) * 100);
    } 
    else if (model === "huggingface") {
      const response = await fetch("https://api-inference.huggingface.co/models/roberta-base-openai-detector", {
        headers: { Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}` },
        method: "POST",
        body: JSON.stringify({ inputs: text }),
      });
      const result = await response.json();

      // [핵심 수정] Hugging Face 로딩 지연(503) 등 에러 전달
      if (result.error) {
        return res.status(400).json({ error: `Hugging Face 오류: ${result.error}` });
      }

      if (Array.isArray(result) && result[0]) {
        const fakeScoreObj = result[0].find(item => item.label === "Fake" || item.label === "LABEL_1");
        aiScore = fakeScoreObj ? Math.round(fakeScoreObj.score * 100) : 0;
      }
    }

    // 성공 시 글자 수 차감 업데이트
    await supabase.from("licenses").update({ used_chars: used + charCount }).eq("license_key", licenseKey);

    return res.json({ success: true, aiScore, usedChars: used + charCount, dailyLimit: limit });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "서버 내부 처리 중 오류가 발생했습니다." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 작동 중 (포트 ${PORT})`));
