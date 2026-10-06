const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
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

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -----------------------------
// Health Check
// -----------------------------
app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Ethiopia Betting",
    status: "online",
    message: "Betting platform server is running."
  });
});

// -----------------------------
// API Health Check
// -----------------------------
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    time: new Date().toISOString()
  });
});

// -----------------------------
// Socket.IO
// -----------------------------
io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.emit("serverMessage", {
    message: "Connected to Ethiopia Betting server."
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// -----------------------------
// Start Server
// -----------------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
