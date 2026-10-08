"use strict";

require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BSD_API_KEY;

// Browser-оос API руу хандах боломжтой.
app.use(express.json());

// public хавтас дахь index.html болон бусад хуудсыг хүргэнэ.
app.use(express.static(path.join(__dirname, "public")));

// Серверийн ажиллагааг шалгах endpoint.
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Зөвшөөрсөн спортын жагсаалт.
// Хэрэгтэй бол энд өөр sport key нэмж болно.
const ALLOWED_SPORTS = new Set([
  "soccer_epl",
  "soccer_uefa_champs_league",
  "basketball_nba",
  "americanfootball_nfl",
  "baseball_mlb",
  "icehockey_nhl",
]);

// Odds API-аас odds авах endpoint:
// /api/odds?sport=soccer_epl
app.get("/api/odds", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: "Серверийн BSD_API_KEY тохируулагдаагүй байна.",
    });
  }

  const sport = String(req.query.sport || "");

  if (!ALLOWED_SPORTS.has(sport)) {
    return res.status(400).json({
      error: "Спортын нэр зөвшөөрөгдөөгүй эсвэл буруу байна.",
      allowedSports: [...ALLOWED_SPORTS],
    });
  }

  try {
    const response = await axios.get(
      `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport)}/odds/`,
      {
        params: {
          apiKey: API_KEY,
          regions: "us",
          markets: "h2h",
          oddsFormat: "decimal",
        },
        timeout: 15000,
      }
    );

    res.json(response.data);
  } catch (error) {
    const apiStatus = error.response?.status;

    console.error(
      "Odds API хүсэлт амжилтгүй:",
      apiStatus || error.message
    );

    if (apiStatus === 401 || apiStatus === 403) {
      return res.status(502).json({
        error: "Odds API түлхүүр буруу эсвэл эрх хүрэлцэхгүй байна.",
      });
    }

    if (apiStatus === 429) {
      return res.status(502).json({
        error: "Odds API хүсэлтийн хязгаарт хүрсэн байна.",
      });
    }

    res.status(502).json({
      error: "Odds мэдээлэл авах үед алдаа гарлаа.",
    });
  }
});

// Бусад API замд 404 буцаана.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint олдсонгүй." });
});

app.listen(PORT, () => {
  console.log(`Сервер ${PORT} порт дээр ажиллаж байна.`);
});
