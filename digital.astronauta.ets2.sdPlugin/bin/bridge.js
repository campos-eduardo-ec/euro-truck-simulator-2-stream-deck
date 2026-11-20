"use strict";
/**
 * Cliente da ponte que roda dentro do jogo (native/astronauta_ets2.cpp).
 *
 * TCP em 127.0.0.1:47831, uma linha por mensagem. Reconecta sozinho a cada 2 s enquanto o
 * jogo estiver fechado, sem encher o log. Node puro, zero dependências.
 */

const net = require("net");

const DEFAULT_PORT = 47831;

function createBridge({ port = DEFAULT_PORT, host = "127.0.0.1", log = () => {} } = {}) {
  const listeners = new Set();
  let socket = null;
  let buffer = "";
  let retryTimer = null;
  let pingTimer = null;
  let stopped = false;
  let lastData = 0;
  let wasConnected = false;

  const status = {
    connected: false, // TCP aberto com a ponte (jogo rodando com a ponte instalada)
    info: null, // {bridge, game, gameName, telemetry, input, commands}
    state: null, // último {t:"state"}
    since: 0,
  };

  function emit() {
    for (const fn of listeners) {
      try {
        fn(status);
      } catch (err) {
        log("erro num ouvinte da ponte:", err.message);
      }
    }
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, 2000);
  }

  function onLine(line) {
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.t === "info") status.info = msg;
    else if (msg.t === "state") status.state = msg;
    else return;
    emit();
  }

  function connect() {
    if (stopped || socket) return;
    const s = net.connect({ port, host });
    socket = s;
    s.setNoDelay(true);
    s.setEncoding("utf8");

    s.on("connect", () => {
      status.connected = true;
      status.since = Date.now();
      lastData = Date.now();
      buffer = "";
      if (!wasConnected) log(`conectado na ponte do jogo (${host}:${port})`);
      wasConnected = true;
      emit();
      pingTimer = setInterval(() => {
        // Jogo travado ou ponte sumida sem fechar o socket: derruba e tenta de novo.
        if (Date.now() - lastData > 15000) s.destroy();
        else write("ping");
      }, 5000);
    });

    s.on("data", (chunk) => {
      lastData = Date.now();
      buffer += chunk;
      if (buffer.length > 1 << 20) buffer = ""; // proteção
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        onLine(line.trim());
      }
    });

    s.on("error", () => {}); // ECONNREFUSED com o jogo fechado é o normal; o close cuida
    s.on("close", () => {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      socket = null;
      const had = status.connected;
      status.connected = false;
      status.state = null;
      if (had) {
        log("ponte do jogo desconectou");
        wasConnected = false;
        emit();
      }
      scheduleRetry();
    });
  }

  function write(line) {
    if (!socket || !status.connected) return false;
    socket.write(line + "\n");
    return true;
  }

  const SAFE = /^[a-z0-9_]+$/;

  return {
    status,
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (socket) socket.destroy();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** verb: "tap" | "down" | "up". Devolve false se o jogo não estiver conectado. */
    command(verb, cmd) {
      if (!["tap", "down", "up"].includes(verb) || !SAFE.test(String(cmd))) return false;
      return write(`${verb} ${cmd}`);
    },
  };
}

module.exports = { createBridge, DEFAULT_PORT };
