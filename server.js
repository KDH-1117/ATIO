const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

// 1. Supabase 데이터베이스 연결 (환경 변수에서 가져옴)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 2. 검사 요청을 처리하는 API 엔드포인트
// [새로 추가할 부분] 로그인 시 라이선스가 진짜인지 확인하는 기능
app.post("/api/verify", async (req, res) => {
  const { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ error: "License key is required." });

  try {
    const { data: license, error } = await supabase
      .from("licenses")
      .select("*")
      .eq("license_key", licenseKey)
      .single();

    if (error || !license) {
      return res.status(401).json({ error: "Invalid license key." });
    }

    return res.json({
      success: true,
      limit: license.daily_limit,
      used: license.used_chars || 0
    });
  } catch (err) {
    return res.status(500).json({ error: "Server error." });
  }
});
app.post("/api/detect", async (req, res) => {
  const { text, licenseKey, model } = req.body;

  if (!text || !licenseKey || !model) {
    return res.status(400).json({ error: "텍스트, 라이선스 키, 모델 선택이 필요합니다." });
  }

  const charCount = text.length;

  try {
    // [DB 확인] 라이선스 키 조회
    const { data: license, error } = await supabase
      .from("licenses")
      .select("*")
      .eq("license_key", licenseKey)
      .single();

    if (error || !license) return res.status(401).json({ error: "유효하지 않은 라이선스 키입니다." });

    // [한도 확인] 글자 수 차감 계산
    const limit = license.daily_limit;
    const used = license.used_chars || 0;

    if (used + charCount > limit) {
      return res.status(403).json({ error: "일일 글자 수 한도가 초과되었습니다." });
    }

    let aiScore = 0;

    // [AI 호출] Sapling 또는 Hugging Face 선택 호출
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
      aiScore = Math.round((result.score || 0) * 100);
    } 
    else if (model === "huggingface") {
      const response = await fetch("https://api-inference.huggingface.co/models/roberta-base-openai-detector", {
        headers: { Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}` },
        method: "POST",
        body: JSON.stringify({ inputs: text }),
      });
      const result = await response.json();
      if (Array.isArray(result) && result[0]) {
        const fakeScoreObj = result[0].find(item => item.label === "Fake" || item.label === "LABEL_1");
        aiScore = fakeScoreObj ? Math.round(fakeScoreObj.score * 100) : 0;
      }
    }

    // [DB 업데이트] 성공 시 사용한 글자 수 더하기
    await supabase.from("licenses").update({ used_chars: used + charCount }).eq("license_key", licenseKey);

    // 결과 반환
    return res.json({ success: true, aiScore, usedChars: used + charCount, dailyLimit: limit });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "서버 처리 중 오류가 발생했습니다." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서버 작동 중 (포트 ${PORT})`));
