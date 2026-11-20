"use strict";
/**
 * Gera o manifest.json do digital.astronauta.ets2 a partir do bin/catalog.js.
 *
 *   node tools/build-manifest.js
 *
 * O catálogo é a fonte da verdade: acrescentar um atalho lá e rodar isto basta.
 */
const fs = require("fs");
const path = require("path");

const SD = path.join(__dirname, "..", "digital.astronauta.ets2.sdPlugin");
const C = require(path.join(SD, "bin", "catalog.js"));
const NS = "digital.astronauta.ets2";
const VERSION = "1.0.0.0";

const keyState = [{ Image: "imgs/key", TitleAlignment: "bottom" }];

function tecla(uuid, nome, tooltip, pi) {
  return {
    Name: nome,
    UUID: `${NS}.${uuid}`,
    Icon: "imgs/action",
    Tooltip: tooltip,
    PropertyInspectorPath: pi,
    Controllers: ["Keypad"],
    States: keyState,
  };
}

const actions = [];

// Atalhos de comando, na ordem do catálogo.
for (const c of C.COMANDOS.filter((x) => x.atalho)) {
  const g = C.GRUPOS[c.grupo].nome;
  const dica = c.tecla ? ` (no teclado: ${c.tecla})` : "";
  const modo = c.modo === "segurar" ? " Segure a tecla." : "";
  actions.push(tecla(c.atalho, c.nome, `${g}: ${c.nome}${dica}. Mostra o estado ao vivo quando o jogo informa.${modo}`, "ui/comando.html"));
}
actions.push(tecla("comando", "Comando do jogo (qualquer)", "Qualquer um dos 122 comandos do jogo. Escolha no inspetor.", "ui/comando.html"));

// Leituras prontas.
for (const f of C.CAMPOS.filter((x) => x.atalho)) {
  actions.push(tecla(f.atalho, `Painel · ${f.nome}`, `${f.nome}, ao vivo do jogo.`, "ui/painel.html"));
}
actions.push(tecla("painel", "Painel (qualquer leitura)", "Escolha no inspetor o que mostrar: viagem, entrega, caminhão ou desgaste.", "ui/painel.html"));

// Dials.
for (const d of C.DIALS) {
  actions.push({
    Name: `Dial · ${d.nome}`,
    UUID: `${NS}.${d.id}`,
    Icon: "imgs/action",
    Tooltip: `Girar: ${d.textos.Rotate.toLowerCase()}. Apertar: ${d.textos.Push.toLowerCase()}. Tocar: ${d.textos.Touch.toLowerCase()}.`,
    PropertyInspectorPath: "ui/dial.html",
    Controllers: ["Encoder"],
    Encoder: { layout: "layouts/clean.json", TriggerDescription: d.textos },
    States: [{ Image: "imgs/key" }],
  });
}

const manifest = {
  $schema: "https://schemas.elgato.com/streamdeck/plugins/manifest.json",
  Name: "Caminhão · ETS2 e ATS",
  UUID: NS,
  Version: VERSION,
  Author: "Eduardo Campos",
  Description:
    "Euro Truck Simulator 2 e American Truck Simulator no Stream Deck +: comandos diretos no jogo (sem simular teclado) e painel ao vivo. Precisa da ponte astronauta_ets2 instalada no jogo.",
  Category: "Caminhão",
  CategoryIcon: "imgs/category",
  Icon: "imgs/icon",
  URL: "https://github.com/campos-eduardo-ec/euro-truck-simulator-2-stream-deck",
  SDKVersion: 2,
  CodePath: "bin/plugin.js",
  Nodejs: { Version: "20" },
  Software: { MinimumVersion: "6.5" },
  OS: [{ Platform: "mac", MinimumVersion: "12" }],
  // Perfil que vem junto: o app oferece instalar com o plugin e o plugin abre ele quando o jogo inicia.
  Profiles: [{ Name: "profiles/Astronauta - Caminhao", DeviceType: 7, ReadOnly: false, DontAutoSwitchWhenInstalled: false }],
  Actions: actions,
};

fs.writeFileSync(path.join(SD, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const uuids = actions.map((a) => a.UUID);
const dup = uuids.filter((u, i) => uuids.indexOf(u) !== i);
if (dup.length) throw new Error(`UUID repetido: ${dup.join(", ")}`);
console.log(`manifest: ${actions.length} ações (${actions.filter((a) => a.Controllers[0] === "Encoder").length} dials)`);
