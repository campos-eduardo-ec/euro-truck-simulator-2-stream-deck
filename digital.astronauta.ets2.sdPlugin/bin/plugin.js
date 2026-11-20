"use strict";
/**
 * digital.astronauta.ets2 — Euro Truck Simulator 2 e American Truck Simulator no Stream Deck +.
 *
 * Fala com a ponte que roda dentro do jogo (native/astronauta_ets2.cpp) por TCP local:
 *   - recebe a telemetria (velocidade, luzes, combustível, entrega...) e desenha as teclas;
 *   - manda comandos semânticos do jogo (engine, parkingbrake, lblinker...), sem simular
 *     teclado e sem precisar do jogo em primeiro plano.
 *
 * Ações:
 *   comando            tecla genérica: qualquer um dos 122 comandos (escolhido no inspetor)
 *   <atalho>           teclas prontas (ignicao, freiomao, piscaesq...), mesmo código
 *   painel             tecla de leitura genérica (campo escolhido no inspetor)
 *   <campo>            leituras prontas (velocidade, combustivel...)
 *   dial*              dials do Stream Deck + (piloto, retarder, faróis, câmera...)
 *
 * Node puro, zero dependências (o app embute o Node).
 */

const { MiniWebSocket } = require("./ws");
const R = require("./render");
const C = require("./catalog");
const V = require("./views");
const { createBridge } = require("./bridge");

// ---------------------------------------------------------------- argumentos

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) out[a.replace(/^-+/, "")] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port);
const PLUGIN_UUID = args.pluginUUID;
const REGISTER_EVENT = args.registerEvent;
const NS = "digital.astronauta.ets2";

function log(...parts) {
  console.log(`[ets2] ${parts.join(" ")}`);
}

function shortAction(action) {
  return String(action || "").startsWith(`${NS}.`) ? action.slice(NS.length + 1) : String(action || "");
}

// Atalhos de comando e de painel, vindos do catálogo.
const ATALHO_CMD = new Map(C.COMANDOS.filter((c) => c.atalho).map((c) => [c.atalho, c.cmd]));
const ATALHO_CAMPO = new Map(C.CAMPOS.filter((c) => c.atalho).map((c) => [c.atalho, c.id]));
const DIAL_IDS = new Set(C.DIALS.map((d) => d.id));

/** Que tipo de coisa uma ação é, e com que comando/campo. */
function resolve(entry) {
  const a = shortAction(entry.action);
  const s = entry.settings || {};
  if (DIAL_IDS.has(a)) return { tipo: "dial", id: a };
  if (a === "comando") return { tipo: "comando", cmd: s.cmd || "engine" };
  if (ATALHO_CMD.has(a)) return { tipo: "comando", cmd: ATALHO_CMD.get(a) };
  if (a === "painel") return { tipo: "painel", campo: s.campo || "velocidade" };
  if (ATALHO_CAMPO.has(a)) return { tipo: "painel", campo: ATALHO_CAMPO.get(a) };
  return { tipo: "desconhecido" };
}

function modoDe(cmd, settings) {
  if (settings && (settings.modo === "toque" || settings.modo === "segurar")) return settings.modo;
  const c = C.POR_CMD.get(cmd);
  return c && c.modo === "segurar" ? "segurar" : "toque";
}

// ---------------------------------------------------------------- estado

let sd = null;
const contexts = new Map(); // context -> { action, controller, settings }
const lastDrawn = new Map();
const holding = new Map(); // context -> cmd apertado (modo segurar)
const bridge = createBridge({
  port: Number(process.env.ASTRONAUTA_ETS2_PORT) || undefined,
  log,
});
let renderTimer = null;

function send(payload) {
  if (sd) sd.send(JSON.stringify(payload));
}

// ---------------------------------------------------------------- render

function viewFor(entry) {
  const r = resolve(entry);
  const st = bridge.status;
  if (r.tipo === "dial") return V.dialView(st, r.id, entry.settings || {});
  if (r.tipo === "comando") return V.comandoView(st, r.cmd, entry.settings || {});
  if (r.tipo === "painel") return V.campo(st, r.campo);
  return { label: shortAction(entry.action).toUpperCase(), value: "?", sub: "ação desconhecida", level: "offline" };
}

function renderOne(context) {
  const entry = contexts.get(context);
  if (!entry) return;
  let view;
  try {
    view = viewFor(entry);
  } catch (err) {
    log(`erro ao montar ${entry.action}: ${err.message}`);
    view = { label: shortAction(entry.action).toUpperCase(), value: "n/d", sub: "erro", level: "offline" };
  }
  const dial = entry.controller === "Encoder";
  const svg = R.clean(view, dial);
  if (lastDrawn.get(context) === svg) return;
  lastDrawn.set(context, svg);
  if (dial) {
    send({ event: "setFeedback", context, payload: { canvas: R.toDataUri(svg) } });
  } else {
    send({ event: "setImage", context, payload: { image: R.toDataUri(svg), target: 0 } });
    send({ event: "setTitle", context, payload: { title: "", target: 0 } });
  }
}

function renderAll() {
  for (const context of contexts.keys()) renderOne(context);
}

/** A telemetria chega a até 10 vezes por segundo; desenha no máximo nesse ritmo. */
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderAll();
  }, 100);
}

bridge.onChange(scheduleRender);

// ---------------------------------------------------------------- perfil automático

/**
 * Quando o jogo abre (a ponte conecta), troca o Stream Deck + para o perfil do caminhão, que vem
 * junto com o plugin. Só na transição fechado -> aberto: se a pessoa trocar de perfil durante o
 * jogo, o plugin não insiste. Desliga com a configuração global { trocarPerfil: false }.
 */
const PERFIL = "profiles/Astronauta - Caminhao";
const devices = new Map(); // id -> tipo
let global = { trocarPerfil: true };
let estavaConectado = false;

function trocarParaPerfil() {
  if (global.trocarPerfil === false) return;
  for (const [device, tipo] of devices) {
    if (tipo !== 7) continue; // 7 = Stream Deck +
    send({ event: "switchToProfile", context: PLUGIN_UUID, device, payload: { profile: PERFIL } });
    log("jogo abriu: perfil do caminhão no Stream Deck +");
  }
}

bridge.onChange((st) => {
  if (st.connected && !estavaConectado) trocarParaPerfil();
  estavaConectado = st.connected;
});

// ---------------------------------------------------------------- ações

function semJogo(context) {
  if (bridge.status.connected) return false;
  send({ event: "showAlert", context });
  return true;
}

function keyDown(context) {
  const entry = contexts.get(context);
  if (!entry) return;
  const r = resolve(entry);
  if (r.tipo !== "comando") return; // teclas de painel só mostram
  if (semJogo(context)) return;
  if (modoDe(r.cmd, entry.settings) === "segurar") {
    holding.set(context, r.cmd);
    bridge.command("down", r.cmd);
  } else {
    bridge.command("tap", r.cmd);
  }
}

function keyUp(context) {
  const cmd = holding.get(context);
  if (!cmd) return;
  holding.delete(context);
  bridge.command("up", cmd);
}

/** Janelas são comandos de segurar: cada clique do dial segura por 0,4 s. */
const SEGURA_MS = 400;
function disparar(cmds) {
  for (const cmd of cmds) {
    const c = C.POR_CMD.get(cmd);
    if (c && c.modo === "segurar" && /^[lr]win/.test(cmd)) {
      bridge.command("down", cmd);
      setTimeout(() => bridge.command("up", cmd), SEGURA_MS);
    } else {
      bridge.command("tap", cmd);
    }
  }
}

function salvar(context, entry, novas) {
  entry.settings = { ...(entry.settings || {}), ...novas };
  send({ event: "setSettings", context, payload: entry.settings });
  lastDrawn.delete(context);
  renderOne(context);
}

function dialGesto(context, gesto, ticks = 1) {
  const entry = contexts.get(context);
  if (!entry) return;
  const id = shortAction(entry.action);
  const s = entry.settings || {};

  if (id === "dialinfo") {
    const total = V.camposDoGrupo(s.grupo || "viagem").length;
    const atual = Number(s.cycleIndex) || 0;
    const passo = gesto === "esq" ? -1 : gesto === "tocar" ? -atual : 1;
    salvar(context, entry, { cycleIndex: (((atual + passo) % total) + total) % total });
    return;
  }
  if (id === "dialjanelas" && (gesto === "apertar" || gesto === "tocar")) {
    salvar(context, entry, { lado: ((Number(s.lado) || 0) + 1) % V.LADOS.length });
    return;
  }

  if (semJogo(context)) return;
  const cmds = V.dialComandos(id, gesto, s);
  const vezes = Math.min(Math.max(1, Math.abs(ticks)), 5); // giro rápido: até 5 passos
  for (let i = 0; i < vezes; i++) setTimeout(() => disparar(cmds), i * 90);
}

// ---------------------------------------------------------------- inspetor

function onSendToPlugin(msg) {
  const { action, context, payload } = msg;
  if (!payload || payload.pedido !== "catalogo") return;
  send({
    event: "sendToPropertyInspector",
    action,
    context,
    payload: {
      catalogo: {
        grupos: C.GRUPOS,
        comandos: C.COMANDOS.map(({ cmd, nome, grupo, tecla, modo }) => ({ cmd, nome, grupo, tecla, modo })),
        campos: C.CAMPOS.map(({ id, nome, grupo }) => ({ id, nome, grupo })),
        gruposInfo: C.GRUPOS_INFO,
      },
      conectado: bridge.status.connected,
      jogo: bridge.status.info ? bridge.status.info.gameName : null,
    },
  });
}

// ---------------------------------------------------------------- conexão com o Stream Deck

function connect() {
  sd = new MiniWebSocket(PORT);

  sd.on("open", () => {
    send({ event: REGISTER_EVENT, uuid: PLUGIN_UUID });
    send({ event: "getGlobalSettings", context: PLUGIN_UUID });
    log("registrado");
    bridge.start();
  });

  sd.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { event, action, context, payload } = msg;
    switch (event) {
      case "deviceDidConnect":
        devices.set(msg.device, msg.deviceInfo && msg.deviceInfo.type);
        break;
      case "deviceDidDisconnect":
        devices.delete(msg.device);
        break;
      case "didReceiveGlobalSettings":
        global = { trocarPerfil: true, ...((payload && payload.settings) || {}) };
        break;
      case "willAppear":
        contexts.set(context, {
          action: action || "",
          controller: (payload && payload.controller) || "Keypad",
          settings: (payload && payload.settings) || {},
        });
        lastDrawn.delete(context);
        renderOne(context);
        break;
      case "willDisappear":
        keyUp(context); // nunca deixa um comando apertado para trás
        contexts.delete(context);
        lastDrawn.delete(context);
        break;
      case "didReceiveSettings": {
        const entry = contexts.get(context);
        if (entry) {
          entry.settings = (payload && payload.settings) || {};
          lastDrawn.delete(context);
          renderOne(context);
        }
        break;
      }
      case "keyDown":
        keyDown(context);
        break;
      case "keyUp":
        keyUp(context);
        break;
      case "dialRotate": {
        const ticks = (payload && payload.ticks) || 0;
        if (ticks) dialGesto(context, ticks > 0 ? "dir" : "esq", ticks);
        break;
      }
      case "dialDown":
        dialGesto(context, "apertar");
        break;
      case "touchTap":
        dialGesto(context, "tocar");
        break;
      case "sendToPlugin":
        onSendToPlugin(msg);
        break;
      default:
        break;
    }
  });

  sd.on("error", (err) => log("erro de socket:", err.message));
  sd.on("close", () => {
    log("socket fechado, encerrando");
    for (const cmd of holding.values()) bridge.command("up", cmd);
    bridge.stop();
    process.exit(0);
  });
}

if (!PORT || !PLUGIN_UUID || !REGISTER_EVENT) {
  console.error("[ets2] argumentos de registro ausentes; o app do Stream Deck os passa.");
  process.exit(1);
}

connect();
