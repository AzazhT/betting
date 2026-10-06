const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 10000;

/*
|--------------------------------------------------------------------------
| PostgreSQL
|--------------------------------------------------------------------------
*/

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err.message);
});

/*
|--------------------------------------------------------------------------
| Middleware
|--------------------------------------------------------------------------
*/

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/*
|--------------------------------------------------------------------------
| Database Initialization
|--------------------------------------------------------------------------
*/

async function initializeDatabase() {
  try {
    const schemaPath = path.join(__dirname, "schema.sql");

    if (!fs.existsSync(schemaPath)) {
      console.log("⚠️ schema.sql not found.");
      return;
    }

    const schema = fs.readFileSync(schemaPath, "utf8");

    await pool.query(schema);

    console.log("✅ Database tables initialized successfully.");

  } catch (error) {
    console.error("❌ Database initialization failed:", error.message);
    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| Basic Server
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Ethiopia Betting",
    status: "online"
  });
});

/*
|--------------------------------------------------------------------------
| Health Check
|--------------------------------------------------------------------------
*/

app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS time");

    res.json({
      success: true,
      server: "healthy",
      database: "healthy",
      time: result.rows[0].time
    });

  } catch (error) {
    console.error("Health check error:", error.message);

    res.status(500).json({
      success: false,
      server: "healthy",
      database: "error"
    });
  }
});

/*
|--------------------------------------------------------------------------
| Database Test
|--------------------------------------------------------------------------
*/

app.get("/api/database-test", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        current_database() AS database,
        current_user AS user
    `);

    res.json({
      success: true,
      message: "PostgreSQL connection successful.",
      database: result.rows[0].database,
      user: result.rows[0].user
    });

  } catch (error) {
    console.error("Database connection error:", error.message);

    res.status(500).json({
      success: false,
      message: "Database connection failed."
    });
  }
});

/*
|--------------------------------------------------------------------------
| Table Test
|--------------------------------------------------------------------------
*/

app.get("/api/tables-test", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    res.json({
      success: true,
      tables: result.rows.map(row => row.table_name)
    });

  } catch (error) {
    console.error("Tables test error:", error.message);

    res.status(500).json({
      success: false,
      message: "Could not read database tables."
    });
  }
});

/*
|--------------------------------------------------------------------------
| Socket.IO
|--------------------------------------------------------------------------
*/

io.on("connection", (socket) => {

  console.log(`Client connected: ${socket.id}`);

  socket.emit("serverMessage", {
    message: "Connected to Ethiopia Betting server."
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });

});

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/

async function startServer() {
  try {

    await initializeDatabase();

    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Ethiopia Betting server running on port ${PORT}`);
    });

  } catch (error) {

    console.error("❌ Server startup failed.");
    process.exit(1);

  }
}

startServer();
