"use strict";
/**
 * fake_sd_ets2.js — teste de ponta a ponta do plugin do caminhão, sem jogo e sem Stream Deck.
 *
 *   Stream Deck falso (WebSocket) -> plugin.js de verdade -> ponte nativa de verdade
 *   (astronauta_ets2.dylib, carregada pelo jogo falso native/build/fake_game)
 *
 * O jogo falso reage aos comandos como o jogo (motor liga, freio de mão solta, pisca acende...)
 * e imprime cada comando que chegou. O teste aperta teclas, gira dials e confere as duas pontas.
 *
 *   SCS_SDK=/pasta/do/sdk native/test/run.sh   # compila a ponte e o jogo falso
 *   node test/fake_sd_ets2.js
 */
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PLUGIN_DIR = path.join(ROOT, "digital.astronauta.ets2.sdPlugin");
const PLUGIN = path.join(PLUGIN_DIR, "bin", "plugin.js");
const NATIVE = path.join(ROOT, "native", "build");
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const NS = "digital.astronauta.ets2";
const BRIDGE_PORT = 47998;

const failures = [];
let passed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, step = 40) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(step); }
  return !!pred();
}

function wsAccept(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

function writeFrame(socket, text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + texto (servidor nao mascara)
  socket.write(Buffer.concat([header, payload]));
}

function makeFrameReader(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buffer.length < off + 2) return;
        len = buffer.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buffer.length < off + 8) return;
        len = Number(buffer.readBigUInt64BE(off));
        off += 8;
      }
      let mask = null;
      if (masked) {
        if (buffer.length < off + 4) return;
        mask = buffer.subarray(off, off + 4);
        off += 4;
      }
      if (buffer.length < off + len) return;
      const payload = Buffer.from(buffer.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(off + len);
      if (opcode === 0x1) onMessage(payload.toString("utf8"));
      if (opcode === 0x8) return;
    }
  };
}

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** data URI do setImage/canvas -> SVG. */
function decodeUri(uri) {
  const i = String(uri || "").indexOf(",");
  if (i < 0) return "";
  try {
    return decodeURIComponent(uri.slice(i + 1));
  } catch {
    return "";
  }
}

/** [rotulo, valor, detalhe] do SVG do R.clean. */
function textsOf(svg) {
  return [...String(svg).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => unesc(m[1]));
}

// ================================================================ testes puros

function unitTests() {
  console.log("\n== 0. manifest, catálogo e views ==");
  const m = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));
  assert(m.UUID === NS && m.SDKVersion === 2, "manifest: UUID e SDK 2");
  assert(m.OS.some((o) => o.Platform === "mac"), "manifest: roda no Mac");
  const existe = (rel) => fs.existsSync(path.join(PLUGIN_DIR, rel));
  const img = (rel) => existe(`${rel}.png`) && existe(`${rel}@2x.png`);
  const faltam = [];
  if (!existe(m.CodePath)) faltam.push(m.CodePath);
  for (const r of [m.Icon, m.CategoryIcon]) if (!img(r)) faltam.push(r);
  for (const a of m.Actions) {
    if (!img(a.Icon)) faltam.push(a.Icon);
    if (!existe(a.PropertyInspectorPath)) faltam.push(a.PropertyInspectorPath);
    if (a.Encoder && !existe(a.Encoder.layout)) faltam.push(a.Encoder.layout);
  }
  assert(faltam.length === 0, `arquivos do manifest existem${faltam.length ? ` (faltam ${[...new Set(faltam)]})` : ""}`);

  const C = require(path.join(PLUGIN_DIR, "bin", "catalog.js"));
  const src = fs.readFileSync(path.join(ROOT, "native", "astronauta_ets2.cpp"), "utf8");
  const nat = [...src.split("COMMANDS[] = {")[1].split("};")[0].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]);
  const cat = C.COMANDOS.map((c) => c.cmd);
  assert(nat.length === cat.length && nat.every((x) => cat.includes(x)), `catálogo = comandos da ponte (${cat.length})`);

  const V = require(path.join(PLUGIN_DIR, "bin", "views.js"));
  const fechado = { connected: false, info: null, state: null };
  assert(V.comandoView(fechado, "engine").sub === "abra o jogo", "jogo fechado: tecla diz 'abra o jogo'");
  assert(V.campo(fechado, "velocidade").value === "—", "jogo fechado: painel sem número inventado");
  const st = {
    connected: true, info: { game: "eut2", input: true },
    state: { paused: false, gameTime: 1440 * 2 + 13 * 60 + 5, restStop: 45,
      truck: { speed: 25, displayedGear: -1, fuel: 200, fuelCapacity: 800, highBeam: false, lowBeam: true, parkingLight: true, cruise: 0 },
      nav: { speedLimit: 80 / 3.6, distance: 123400, time: 5400 }, trailer: { connected: false },
      job: { active: true, deliveryTime: 1440 * 2 + 13 * 60 + 5 + 30, destinationCity: "Lyon", income: 15400 }, event: {} },
  };
  assert(V.campo(st, "velocidade").level === "warn", "90 km/h num limite de 80 fica amarelo (vermelho a partir de 95)");
  assert(V.campo(st, "horario").value === "13:05" && V.campo(st, "horario").sub === "QUA", "hora do jogo e dia da semana");
  assert(V.campo(st, "descanso").level === "warn", "descanso em 45 min avisa");
  assert(V.campo(st, "prazo").level === "danger", "prazo de 30 min fica vermelho");
  assert(V.campo(st, "combustivel").value === "25%" && V.campo(st, "combustivel").level === "safe", "combustível em %");
  assert(V.campo(st, "marcha").value === "R1", "marcha à ré");
  assert(V.comandoView(st, "light").value === "BAIXO", "faróis: modo baixo");
  assert(V.campo({ ...st, info: { game: "ats", input: true } }, "velocidade").sub.startsWith("mph"), "ATS usa mph");
  assert(JSON.stringify(V.dialComandos("dialsuspensao", "dir")) === '["frontsuspup","rearsuspup"]', "dial de suspensão sobe os dois eixos");
  assert(JSON.stringify(V.dialComandos("dialjanelas", "esq", { lado: 2 })) === '["rwinclose"]', "dial de janela fecha só a direita");
}

// ================================================================ ponta a ponta

async function e2e() {
  console.log("\n== 1. ponta a ponta: Stream Deck falso + plugin + ponte nativa ==");
  const gameBin = path.join(NATIVE, "fake_game");
  const dylib = path.join(NATIVE, "astronauta_ets2.dylib");
  if (!fs.existsSync(gameBin) || !fs.existsSync(dylib)) {
    assert(false, "ponte e jogo falso compilados (rode native/test/run.sh)");
    return;
  }

  const images = new Map();
  const feedback = new Map();
  const alerts = [];
  let sock = null;
  const send = (o) => sock && writeFrame(sock, JSON.stringify(o));
  const instances = [
    { context: "k-ign", action: "ignicao", controller: "Keypad" },
    { context: "k-freio", action: "freiomao", controller: "Keypad" },
    { context: "k-pisca", action: "piscaesq", controller: "Keypad" },
    { context: "k-buzina", action: "buzina", controller: "Keypad" },
    { context: "k-vel", action: "velocidade", controller: "Keypad" },
    { context: "k-gen", action: "comando", controller: "Keypad", settings: { cmd: "beacon" } },
    { context: "d-piloto", action: "dialpiloto", controller: "Encoder" },
    { context: "d-luzes", action: "dialluzes", controller: "Encoder" },
    { context: "d-ret", action: "dialretarder", controller: "Encoder" },
    { context: "d-info", action: "dialinfo", controller: "Encoder", settings: { grupo: "viagem" } },
  ];

  const server = net.createServer((socket) => {
    sock = socket;
    let up = false;
    let head = Buffer.alloc(0);
    const reader = makeFrameReader((text) => {
      const msg = JSON.parse(text);
      if (msg.event === "registerPlugin") {
        setTimeout(() => {
          for (const i of instances) send({ event: "willAppear", action: `${NS}.${i.action}`, context: i.context, payload: { controller: i.controller, settings: i.settings || {} } });
        }, 20);
      } else if (msg.event === "setImage") images.set(msg.context, decodeUri(msg.payload.image));
      else if (msg.event === "setFeedback") feedback.set(msg.context, decodeUri(msg.payload.canvas));
      else if (msg.event === "showAlert") alerts.push(msg.context);
      else if (msg.event === "setSettings") send({ event: "didReceiveSettings", context: msg.context, payload: { settings: msg.payload } });
    });
    socket.on("data", (chunk) => {
      if (up) return reader(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head.subarray(0, end).toString("latin1"))[1];
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);
      up = true;
      const rest = head.subarray(end + 4);
      if (rest.length) reader(rest);
    });
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const env = { ...process.env, ASTRONAUTA_ETS2_PORT: String(BRIDGE_PORT) };
  const plugin = spawn(process.execPath, [PLUGIN, "-port", String(server.address().port), "-pluginUUID", "t", "-registerEvent", "registerPlugin", "-info", "{}"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const plog = [];
  plugin.stdout.on("data", (d) => plog.push(String(d)));
  plugin.stderr.on("data", (d) => plog.push(String(d)));

  const texts = (ctx) => textsOf(images.get(ctx) || feedback.get(ctx) || "");
  const has = (ctx, s) => texts(ctx).some((t) => t.includes(s));

  // 1) jogo fechado
  await waitFor(() => instances.every((i) => images.has(i.context) || feedback.has(i.context)), 5000);
  assert(has("k-ign", "abra o jogo") && has("d-piloto", "abra o jogo"), "sem jogo: teclas e dials dizem 'abra o jogo'");
  send({ event: "keyDown", context: "k-ign", payload: {} });
  await waitFor(() => alerts.includes("k-ign"), 1000);
  assert(alerts.includes("k-ign"), "sem jogo: apertar mostra alerta");

  // 2) abre o jogo falso
  const cmds = [];
  const game = spawn("arch", ["-x86_64", gameBin, dylib, "--serve", "15"], { env, stdio: ["ignore", "pipe", "pipe"] });
  game.stdout.on("data", (d) => { for (const l of String(d).split("\n")) if (l.startsWith("CMD ")) cmds.push(l.slice(4).trim()); });
  const conectou = await waitFor(() => has("k-ign", "DESLIGADO"), 8000);
  assert(conectou, "plugin conecta sozinho quando o jogo abre (motor DESLIGADO)");
  assert(has("k-freio", "PUXADO"), "freio de mão aparece PUXADO");
  assert(has("k-vel", "72"), "velocidade 72 km/h (20 m/s)");

  // 3) teclas
  send({ event: "keyDown", context: "k-ign", payload: {} });
  send({ event: "keyUp", context: "k-ign", payload: {} });
  assert(await waitFor(() => cmds.includes("engine 1") && cmds.includes("engine 0"), 3000), "ignição: jogo recebe apertar e soltar");
  assert(await waitFor(() => has("k-ign", "LIGADO") && !has("k-ign", "DESLIGADO"), 3000), "ignição: tecla vira LIGADO pela telemetria");
  send({ event: "keyDown", context: "k-freio", payload: {} });
  assert(await waitFor(() => has("k-freio", "SOLTO"), 3000), "freio de mão solta");
  send({ event: "keyDown", context: "k-pisca", payload: {} });
  assert(await waitFor(() => has("k-pisca", "ligado"), 3000), "pisca esquerdo liga");

  // segurar: buzina fica apertada até soltar
  send({ event: "keyDown", context: "k-buzina", payload: {} });
  await sleep(500);
  assert(cmds.includes("horn 1") && !cmds.includes("horn 0"), "buzina: continua apertada enquanto o dedo está");
  send({ event: "keyUp", context: "k-buzina", payload: {} });
  assert(await waitFor(() => cmds.includes("horn 0"), 2000), "buzina: solta junto com a tecla");

  send({ event: "keyDown", context: "k-gen", payload: {} });
  assert(await waitFor(() => cmds.includes("beacon 1"), 2000), "tecla genérica manda o comando escolhido (giroflex)");

  // 4) dials
  send({ event: "dialDown", context: "d-piloto", payload: {} });
  assert(await waitFor(() => texts("d-piloto").some((t) => /^72 km\/h$/.test(t)), 3000), "dial piloto: aperta e liga em 72 km/h");
  send({ event: "dialRotate", context: "d-piloto", payload: { ticks: 3 } });
  assert(await waitFor(() => cmds.filter((c) => c === "cruiectrlinc 1").length === 3, 3000), "dial piloto: 3 cliques = 3 aumentos");
  assert(await waitFor(() => texts("d-piloto").some((t) => /^75 km\/h$/.test(t)), 3000), "dial piloto: mostra 75 km/h");
  send({ event: "dialRotate", context: "d-luzes", payload: { ticks: 1 } });
  send({ event: "dialRotate", context: "d-luzes", payload: { ticks: 1 } });
  assert(await waitFor(() => has("d-luzes", "BAIXO"), 3000), "dial faróis: dois cliques = farol baixo");
  send({ event: "dialRotate", context: "d-ret", payload: { ticks: 2 } });
  assert(await waitFor(() => has("d-ret", "2/4"), 3000), "dial retarder: 2/4");
  const antes = texts("d-info").join("|");
  send({ event: "dialRotate", context: "d-info", payload: { ticks: 1 } });
  assert(await waitFor(() => texts("d-info").join("|") !== antes && has("d-info", "2/"), 2000), "dial info: gira para o próximo campo");

  // 5) jogo fecha
  game.kill("SIGTERM");
  assert(await waitFor(() => has("k-ign", "abra o jogo"), 5000), "jogo fechou: teclas voltam a 'abra o jogo'");

  sock.destroy();
  const saiu = await waitFor(() => plugin.exitCode !== null, 3000);
  assert(saiu, "plugin sai quando o Stream Deck fecha");
  server.close();
  if (failures.length) console.log(plog.join("").slice(-2000));
}

(async () => {
  unitTests();
  await e2e();
  console.log(`\n${passed} passaram, ${failures.length} falharam`);
  process.exit(failures.length ? 1 : 0);
})();
