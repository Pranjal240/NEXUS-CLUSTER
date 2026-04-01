import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import net from "node:net";
import { Server } from "socket.io";
import cluster from "node:cluster";
import { createAdapter, setupPrimary } from "@socket.io/cluster-adapter";
import { exec } from "node:child_process";
import { open } from "sqlite";
import sqlite3 from "sqlite3";

function getCliArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const requestedBasePort = Number(
  getCliArg("base-port") || process.env.BASE_PORT || 3000,
);
const BASE_PORT = Number.isFinite(requestedBasePort) ? requestedBasePort : 3000;

const requestedWorkers = Number(
  getCliArg("workers") || process.env.WORKERS || 4,
);
const TOTAL_SERVERS =
  requestedWorkers === 3 || requestedWorkers === 4 ? requestedWorkers : 4;

if (cluster.isPrimary && requestedWorkers !== TOTAL_SERVERS) {
  console.warn(
    `Invalid workers value "${requestedWorkers}". Using ${TOTAL_SERVERS}. Choose 3 or 4.`,
  );
}

const CLUSTER_PORTS = Array.from(
  { length: TOTAL_SERVERS },
  (_, index) => BASE_PORT + index,
);
const __dirname = dirname(fileURLToPath(import.meta.url));

function openBrowser(url) {
  if (process.env.AUTO_OPEN === "false") {
    return;
  }

  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;

  exec(command, (error) => {
    if (error) {
      console.warn("Could not open browser automatically.", error.message);
    }
  });
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });

    socket.setTimeout(300);

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.once("error", (error) => {
      const expected = [
        "ECONNREFUSED",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "ETIMEDOUT",
      ];
      resolve(!expected.includes(error.code));
    });
  });
}

async function isPortFree(port) {
  const loopbackBusy =
    (await canConnect("127.0.0.1", port)) || (await canConnect("::1", port));
  if (loopbackBusy) {
    return false;
  }

  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once("error", () => {
      resolve(false);
    });

    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });

    tester.listen(port);
  });
}

async function getBusyPorts(ports) {
  const checks = await Promise.all(
    ports.map(async (port) => ({
      port,
      free: await isPortFree(port),
    })),
  );

  return checks.filter((check) => !check.free).map((check) => check.port);
}

if (cluster.isPrimary) {
  setupPrimary();
  const workerPorts = new Map();
  const blockedPorts = new Set();

  const busyPorts = await getBusyPorts(CLUSTER_PORTS);
  if (busyPorts.length > 0) {
    console.error(
      `Cannot start: ports already in use -> ${busyPorts.join(", ")}. Stop the previous process first.`,
    );
    process.exit(1);
  }

  function spawnWorker(port) {
    const worker = cluster.fork({
      PORT: String(port),
      BASE_PORT: String(BASE_PORT),
      WORKERS: String(TOTAL_SERVERS),
    });
    workerPorts.set(worker.id, port);
    return worker;
  }

  console.log(
    `>>> Master cluster started. Forking ${TOTAL_SERVERS} servers...`,
  );

  CLUSTER_PORTS.forEach((port) => {
    spawnWorker(port);
  });

  cluster.on("message", (worker, message) => {
    if (message?.type === "port_in_use" && Number.isInteger(message.port)) {
      blockedPorts.add(message.port);
      console.error(
        `Port ${message.port} is now in use by another process. Worker restart disabled for this port.`,
      );
    }
  });

  cluster.on("exit", (worker, code, signal) => {
    const port = workerPorts.get(worker.id) || BASE_PORT;
    workerPorts.delete(worker.id);

    if (blockedPorts.has(port)) {
      console.error(
        `Worker ${worker.process.pid} exited for blocked port ${port}. Not restarting to avoid loop.`,
      );
      return;
    }

    console.warn(
      `Worker ${worker.process.pid} exited (code=${code}, signal=${signal}). Restarting...`,
    );
    spawnWorker(port);
  });

  setTimeout(() => {
    console.log(">>> Opening browser...");
    openBrowser(`http://localhost:${BASE_PORT}`);
  }, 1200);
} else {
  const db = await open({
    filename: join(__dirname, "chat.db"),
    driver: sqlite3.Database,
  });

  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
    adapter: createAdapter(),
  });

  function maybeAck(callback, payload = { ok: true }) {
    if (typeof callback === "function") {
      callback(payload);
    }
  }

  app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "index.html"));
  });

  app.get("/cluster-info", (req, res) => {
    res.json({
      basePort: BASE_PORT,
      totalServers: TOTAL_SERVERS,
      ports: CLUSTER_PORTS,
      currentPort: Number(process.env.PORT || BASE_PORT),
    });
  });

  io.on("connection", async (socket) => {
    socket.on("clear chat", async () => {
      try {
        await db.exec("BEGIN IMMEDIATE TRANSACTION");
        await db.run("DELETE FROM messages");
        await db.run("DELETE FROM sqlite_sequence WHERE name = 'messages'");
        await db.exec("COMMIT");
        io.emit("chat cleared");
      } catch (e) {
        try {
          await db.exec("ROLLBACK");
        } catch {
          // Ignore rollback errors when no transaction is active.
        }
        console.error(e);
      }
    });

    socket.on("chat message", async (msg, clientOffset, username, callback) => {
      const text = String(msg || "")
        .trim()
        .slice(0, 1000);
      const sender = String(username || "Anonymous")
        .trim()
        .slice(0, 40);
      const offset = String(clientOffset || "").trim();

      if (!text || !offset) {
        maybeAck(callback, { ok: false, reason: "invalid_payload" });
        return;
      }

      try {
        const result = await db.run(
          "INSERT INTO messages (content, client_offset, username) VALUES (?, ?, ?)",
          [text, offset, sender],
        );

        const currentPort = process.env.PORT;
        io.emit("chat message", text, result.lastID, sender, currentPort);
        maybeAck(callback);
      } catch (e) {
        if (String(e.message).includes("UNIQUE constraint failed")) {
          maybeAck(callback, { ok: true, duplicate: true });
        } else {
          console.error("Failed to store message", e);
          maybeAck(callback, { ok: false, reason: "db_error" });
        }
      }
    });

    if (!socket.recovered) {
      try {
        const lastSeenOffset = Number(socket.handshake.auth.serverOffset || 0);
        const rows = await db.all(
          "SELECT id, content, username FROM messages WHERE id > ? ORDER BY id ASC",
          [lastSeenOffset],
        );

        rows.forEach((row) => {
          socket.emit(
            "chat message",
            row.content,
            row.id,
            row.username,
            "History",
          );
        });
      } catch (e) {
        console.error("Failed to load history", e);
      }
    }
  });

  const port = Number(process.env.PORT || BASE_PORT);
  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      if (typeof process.send === "function") {
        process.send({ type: "port_in_use", port });
      }
      console.error(`Port ${port} is already in use.`);
      process.exit(1);
      return;
    }

    console.error("Server failed to start", error);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`Worker ${process.pid} running at http://localhost:${port}`);
  });
}
