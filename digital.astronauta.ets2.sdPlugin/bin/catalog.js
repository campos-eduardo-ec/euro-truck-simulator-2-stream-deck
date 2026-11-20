"use strict";
/**
 * Catálogo único do plugin do caminhão: comandos do jogo, campos de painel e dials.
 *
 * Fonte da verdade para três coisas: o plugin (bin/plugin.js), o manifest (gerado por
 * tools/build-manifest.js) e o perfil (profiles/build_profile.py lê o manifest).
 *
 * `cmd` é o nome do comando semântico do jogo (def/.../default_input.sii do ETS2 1.60). A ponte
 * nativa aceita exatamente esses nomes. `tecla` é o atalho de fábrica no teclado, só para
 * mostrar na tecla; o plugin nunca simula teclado.
 */

const GRUPOS = {
  dirigir: { nome: "Dirigir", cor: "#ef985d" },
  luzes: { nome: "Luzes", cor: "#ffd166" },
  cambio: { nome: "Câmbio", cor: "#76b900" },
  reboque: { nome: "Reboque e eixos", cor: "#4dd0e1" },
  cabine: { nome: "Cabine e rádio", cor: "#b48cff" },
  camera: { nome: "Câmera", cor: "#5aa9ff" },
  jogo: { nome: "Jogo e Route Advisor", cor: "#acb8c8" },
};

/**
 * Comandos. `modo`: "toque" (aperta e solta) ou "segurar" (fica apertado enquanto o dedo
 * estiver na tecla). `estado`: nome de um leitor em ESTADOS (opcional). `atalho`: vira uma
 * ação própria no Stream Deck (UUID digital.astronauta.ets2.<atalho>).
 */
const COMANDOS = [
  // Dirigir
  { cmd: "engine", nome: "Ignição", curto: "MOTOR", grupo: "dirigir", tecla: "E", estado: "motor", atalho: "ignicao" },
  { cmd: "engineelect", nome: "Parte elétrica", curto: "ELÉTRICA", grupo: "dirigir", estado: "eletrica" },
  { cmd: "parkingbrake", nome: "Freio de mão", curto: "FREIO", grupo: "dirigir", tecla: "Espaço", estado: "freioMao", atalho: "freiomao" },
  { cmd: "motorbrake", nome: "Freio motor", curto: "FREIO MOTOR", grupo: "dirigir", tecla: "B", estado: "freioMotor", atalho: "freiomotor" },
  { cmd: "retarderup", nome: "Retarder +", curto: "RET +", grupo: "dirigir", tecla: ";", estado: "retarder" },
  { cmd: "retarderdown", nome: "Retarder −", curto: "RET −", grupo: "dirigir", tecla: "'", estado: "retarder" },
  { cmd: "retarderauto", nome: "Retarder automático", curto: "RET AUTO", grupo: "dirigir" },
  { cmd: "engbraketog", nome: "Freio motor: liga/desliga", curto: "FM", grupo: "dirigir" },
  { cmd: "engbrakeup", nome: "Freio motor +", curto: "FM +", grupo: "dirigir" },
  { cmd: "engbrakedwn", nome: "Freio motor −", curto: "FM −", grupo: "dirigir" },
  { cmd: "engbrakeauto", nome: "Freio motor automático", curto: "FM AUTO", grupo: "dirigir" },
  { cmd: "trailerbrake", nome: "Freio do reboque", curto: "FREIO REB.", grupo: "dirigir", modo: "segurar" },
  { cmd: "embrake", nome: "Freio de emergência", curto: "EMERG.", grupo: "dirigir", modo: "segurar" },
  { cmd: "cruiectrl", nome: "Piloto automático", curto: "PILOTO", grupo: "dirigir", tecla: "C", estado: "piloto", atalho: "piloto" },
  { cmd: "cruiectrlinc", nome: "Piloto automático +", curto: "PILOTO +", grupo: "dirigir", estado: "piloto" },
  { cmd: "cruiectrldec", nome: "Piloto automático −", curto: "PILOTO −", grupo: "dirigir", estado: "piloto" },
  { cmd: "cruiectrlres", nome: "Piloto: retomar", curto: "RETOMAR", grupo: "dirigir", estado: "piloto" },
  { cmd: "accmode", nome: "Piloto adaptativo: modo", curto: "ACC", grupo: "dirigir" },
  { cmd: "laneassist", nome: "Assistente de faixa", curto: "FAIXA", grupo: "dirigir" },
  { cmd: "laneassmode", nome: "Assistente de faixa: modo", curto: "FAIXA MODO", grupo: "dirigir" },
  { cmd: "horn", nome: "Buzina", curto: "BUZINA", grupo: "dirigir", tecla: "H", modo: "segurar", atalho: "buzina" },
  { cmd: "airhorn", nome: "Buzina a ar", curto: "BUZINA AR", grupo: "dirigir", tecla: "N", modo: "segurar", atalho: "buzinaar" },

  // Luzes
  { cmd: "lblinker", nome: "Pisca esquerdo", curto: "◀", grupo: "luzes", tecla: "[", estado: "piscaEsq", atalho: "piscaesq" },
  { cmd: "rblinker", nome: "Pisca direito", curto: "▶", grupo: "luzes", tecla: "]", estado: "piscaDir", atalho: "piscadir" },
  { cmd: "flasher4way", nome: "Alerta", curto: "ALERTA", grupo: "luzes", tecla: "F", estado: "alerta", atalho: "alerta" },
  { cmd: "light", nome: "Faróis", curto: "FARÓIS", grupo: "luzes", tecla: "L", estado: "farois", atalho: "farois" },
  { cmd: "hblight", nome: "Farol alto", curto: "ALTO", grupo: "luzes", tecla: "K", estado: "farolAlto", atalho: "farolalto" },
  { cmd: "lighthorn", nome: "Lampejo", curto: "LAMPEJO", grupo: "luzes", tecla: "J", modo: "segurar", atalho: "lampejo" },
  { cmd: "beacon", nome: "Giroflex", curto: "GIROFLEX", grupo: "luzes", tecla: "O", estado: "giroflex", atalho: "giroflex" },
  { cmd: "wipers", nome: "Limpador", curto: "LIMPADOR", grupo: "luzes", tecla: "P", estado: "limpador", atalho: "limpador" },
  { cmd: "wipersback", nome: "Limpador (voltar)", curto: "LIMP. −", grupo: "luzes", estado: "limpador" },

  // Câmbio
  { cmd: "gearup", nome: "Marcha acima", curto: "MARCHA +", grupo: "cambio", tecla: "Shift", estado: "marcha" },
  { cmd: "geardown", nome: "Marcha abaixo", curto: "MARCHA −", grupo: "cambio", tecla: "Ctrl", estado: "marcha" },
  { cmd: "gear0", nome: "Neutro", curto: "N", grupo: "cambio", estado: "marcha" },
  { cmd: "geardrive", nome: "Drive", curto: "D", grupo: "cambio", estado: "marcha" },
  { cmd: "gearreverse", nome: "Ré", curto: "R", grupo: "cambio", estado: "marcha" },
  { cmd: "drive", nome: "Drive (alavanca)", curto: "D", grupo: "cambio", estado: "marcha" },
  { cmd: "reverse", nome: "Ré (alavanca)", curto: "R", grupo: "cambio", estado: "marcha" },
  { cmd: "gearuphint", nome: "Marcha acima (sugestão)", curto: "SUG +", grupo: "cambio" },
  { cmd: "geardownhint", nome: "Marcha abaixo (sugestão)", curto: "SUG −", grupo: "cambio" },
  { cmd: "gearsel1tgl", nome: "Faixa alta/baixa", curto: "FAIXA", grupo: "cambio" },
  { cmd: "gearsel1on", nome: "Faixa alta: liga", curto: "FAIXA ON", grupo: "cambio" },
  { cmd: "gearsel1off", nome: "Faixa alta: desliga", curto: "FAIXA OFF", grupo: "cambio" },
  { cmd: "gearsel2tgl", nome: "Splitter", curto: "SPLIT", grupo: "cambio" },
  { cmd: "gearsel2on", nome: "Splitter: liga", curto: "SPLIT ON", grupo: "cambio" },
  { cmd: "gearsel2off", nome: "Splitter: desliga", curto: "SPLIT OFF", grupo: "cambio" },
  { cmd: "transemi", nome: "Câmbio: automático/manual", curto: "A/M", grupo: "cambio" },
  { cmd: "tranpwrmode", nome: "Câmbio: modo potência", curto: "POTÊNCIA", grupo: "cambio" },
  ...Array.from({ length: 16 }, (_, i) => ({
    cmd: `gear${i + 1}`, nome: `Marcha ${i + 1}`, curto: String(i + 1), grupo: "cambio", estado: "marcha",
  })),

  // Reboque e eixos
  { cmd: "attach", nome: "Engatar / soltar reboque", curto: "ENGATE", grupo: "reboque", tecla: "T", estado: "reboque", atalho: "reboque" },
  { cmd: "diflock", nome: "Bloqueio do diferencial", curto: "DIFER.", grupo: "reboque", tecla: "V", estado: "diferencial", atalho: "diferencial" },
  { cmd: "liftaxle", nome: "Eixo elevável", curto: "EIXO", grupo: "reboque", tecla: "U", estado: "eixo", atalho: "eixo" },
  { cmd: "liftaxlet", nome: "Eixo elevável do reboque", curto: "EIXO REB.", grupo: "reboque", estado: "eixoReboque", atalho: "eixoreboque" },
  { cmd: "frontsuspup", nome: "Suspensão dianteira +", curto: "SUSP D +", grupo: "reboque" },
  { cmd: "frontsuspdwn", nome: "Suspensão dianteira −", curto: "SUSP D −", grupo: "reboque" },
  { cmd: "rearsuspup", nome: "Suspensão traseira +", curto: "SUSP T +", grupo: "reboque" },
  { cmd: "rearsuspdwn", nome: "Suspensão traseira −", curto: "SUSP T −", grupo: "reboque" },
  { cmd: "suspreset", nome: "Suspensão: nivelar", curto: "NIVELAR", grupo: "reboque" },

  // Cabine e rádio
  { cmd: "lwinopen", nome: "Janela esquerda: abrir", curto: "JAN E ▼", grupo: "cabine", modo: "segurar" },
  { cmd: "lwinclose", nome: "Janela esquerda: fechar", curto: "JAN E ▲", grupo: "cabine", modo: "segurar" },
  { cmd: "rwinopen", nome: "Janela direita: abrir", curto: "JAN D ▼", grupo: "cabine", modo: "segurar" },
  { cmd: "rwinclose", nome: "Janela direita: fechar", curto: "JAN D ▲", grupo: "cabine", modo: "segurar" },
  { cmd: "display", nome: "Tela do painel", curto: "TELA", grupo: "cabine", tecla: "I" },
  { cmd: "infotainment", nome: "Central multimídia", curto: "MÍDIA", grupo: "cabine" },
  { cmd: "dashmapzoom", nome: "Zoom do mapa do painel", curto: "ZOOM", grupo: "cabine" },
  { cmd: "tripreset", nome: "Zerar viagem", curto: "ZERAR", grupo: "cabine" },
  { cmd: "radio", nome: "Rádio: liga/desliga", curto: "RÁDIO", grupo: "cabine", tecla: "R", atalho: "radio" },
  { cmd: "radioup", nome: "Rádio: volume +", curto: "VOL +", grupo: "cabine" },
  { cmd: "radiodown", nome: "Rádio: volume −", curto: "VOL −", grupo: "cabine" },
  { cmd: "radionext", nome: "Rádio: próxima estação", curto: "ESTAÇÃO ▶", grupo: "cabine", tecla: "PgDn" },
  { cmd: "radioprev", nome: "Rádio: estação anterior", curto: "◀ ESTAÇÃO", grupo: "cabine", tecla: "PgUp" },

  // Câmera
  { cmd: "camcycle", nome: "Trocar câmera", curto: "CÂMERA", grupo: "camera", tecla: "9", atalho: "camera" },
  { cmd: "cam1", nome: "Câmera 1 (cabine)", curto: "CAM 1", grupo: "camera", tecla: "1" },
  { cmd: "cam3", nome: "Câmera 3", curto: "CAM 3", grupo: "camera", tecla: "3" },
  { cmd: "camreset", nome: "Recentrar câmera", curto: "CENTRO", grupo: "camera" },
  { cmd: "camzoom", nome: "Zoom da câmera", curto: "ZOOM", grupo: "camera", modo: "segurar" },
  { cmd: "showmirrors", nome: "Retrovisores na tela", curto: "ESPELHOS", grupo: "camera", tecla: "F2", atalho: "espelhos" },
  { cmd: "camwalk_for", nome: "Andar: frente", curto: "▲", grupo: "camera", modo: "segurar" },
  { cmd: "camwalk_back", nome: "Andar: trás", curto: "▼", grupo: "camera", modo: "segurar" },
  { cmd: "camwalk_left", nome: "Andar: esquerda", curto: "◀", grupo: "camera", modo: "segurar" },
  { cmd: "camwalk_righ", nome: "Andar: direita", curto: "▶", grupo: "camera", modo: "segurar" },
  { cmd: "camwalk_run", nome: "Andar: correr", curto: "CORRER", grupo: "camera", modo: "segurar" },
  { cmd: "camwalk_jump", nome: "Andar: pular", curto: "PULAR", grupo: "camera" },
  { cmd: "photo_mode", nome: "Modo foto", curto: "FOTO", grupo: "camera", tecla: "=" },
  { cmd: "photo_zoom", nome: "Modo foto: zoom", curto: "ZOOM", grupo: "camera", modo: "segurar" },
  { cmd: "photorolll", nome: "Modo foto: girar ←", curto: "↺", grupo: "camera", modo: "segurar" },
  { cmd: "photorollr", nome: "Modo foto: girar →", curto: "↻", grupo: "camera", modo: "segurar" },
  { cmd: "screenshot", nome: "Captura de tela", curto: "PRINT", grupo: "camera", tecla: "F10" },

  // Jogo e Route Advisor
  { cmd: "menu", nome: "Menu / pausa", curto: "MENU", grupo: "jogo", tecla: "Esc", atalho: "menu" },
  { cmd: "navmap", nome: "Mapa", curto: "MAPA", grupo: "jogo", tecla: "M", atalho: "mapa" },
  { cmd: "activate", nome: "Ativar (Enter)", curto: "ENTER", grupo: "jogo", tecla: "Enter", atalho: "ativar" },
  { cmd: "showhud", nome: "Mostrar/ocultar HUD", curto: "HUD", grupo: "jogo", tecla: "F3" },
  { cmd: "adjuster", nome: "Ajuste do banco", curto: "BANCO", grupo: "jogo", tecla: "F4" },
  { cmd: "advzoomout", nome: "Route Advisor: zoom", curto: "RA ZOOM", grupo: "jogo", tecla: "F5" },
  { cmd: "advzoomin", nome: "Route Advisor: aproximar", curto: "RA +", grupo: "jogo" },
  { cmd: "advoptions", nome: "Route Advisor: opções", curto: "RA OPÇ.", grupo: "jogo", tecla: "F6" },
  { cmd: "advmouse", nome: "Route Advisor: mouse", curto: "RA MOUSE", grupo: "jogo", tecla: "F1" },
  { cmd: "services", nome: "Serviços próximos", curto: "SERVIÇOS", grupo: "jogo", tecla: "F7" },
  ...[1, 2, 3, 4, 5].map((n) => ({
    cmd: `assistact${n}`, nome: `Route Advisor: ação ${n}`, curto: `RA ${n}`, grupo: "jogo", tecla: String(n),
  })),
  { cmd: "quick_chat", nome: "Chat rápido", curto: "CHAT", grupo: "jogo", tecla: "Q" },
  { cmd: "chat_act", nome: "Chat", curto: "CHAT", grupo: "jogo", tecla: "Y" },
  { cmd: "mpptt", nome: "Falar (multiplayer)", curto: "FALAR", grupo: "jogo", tecla: "X", modo: "segurar" },
  { cmd: "name_tags", nome: "Nomes dos jogadores", curto: "NOMES", grupo: "jogo", tecla: "Z" },
];

const POR_CMD = new Map(COMANDOS.map((c) => [c.cmd, c]));

// ---------------------------------------------------------------- campos de painel

/**
 * Campos de leitura. `grupo` serve para o dial de informações (gira dentro do grupo).
 * O cálculo de cada um mora em bin/views.js (função `campo`).
 */
const CAMPOS = [
  { id: "velocidade", nome: "Velocidade", grupo: "viagem", atalho: "velocidade" },
  { id: "limite", nome: "Limite de velocidade", grupo: "viagem", atalho: "limite" },
  { id: "distancia", nome: "Distância até o destino", grupo: "viagem" },
  { id: "chegada", nome: "Tempo até o destino", grupo: "viagem" },
  { id: "horario", nome: "Hora no jogo", grupo: "viagem", atalho: "horario" },
  { id: "descanso", nome: "Próximo descanso", grupo: "viagem", atalho: "descanso" },
  { id: "destino", nome: "Destino da entrega", grupo: "entrega" },
  { id: "carga", nome: "Carga", grupo: "entrega" },
  { id: "prazo", nome: "Prazo da entrega", grupo: "entrega" },
  { id: "renda", nome: "Valor da entrega", grupo: "entrega" },
  { id: "danocarga", nome: "Dano da carga", grupo: "entrega", atalho: "danocarga" },
  { id: "evento", nome: "Último acontecimento", grupo: "entrega" },
  { id: "combustivel", nome: "Combustível", grupo: "caminhao", atalho: "combustivel" },
  { id: "autonomia", nome: "Autonomia", grupo: "caminhao" },
  { id: "consumo", nome: "Consumo médio", grupo: "caminhao" },
  { id: "adblue", nome: "AdBlue", grupo: "caminhao" },
  { id: "rpm", nome: "Rotação do motor", grupo: "caminhao" },
  { id: "marcha", nome: "Marcha", grupo: "caminhao", atalho: "marcha" },
  { id: "ar", nome: "Pressão do ar", grupo: "caminhao", atalho: "ar" },
  { id: "oleo", nome: "Temperatura do óleo", grupo: "caminhao" },
  { id: "agua", nome: "Temperatura da água", grupo: "caminhao" },
  { id: "bateria", nome: "Bateria", grupo: "caminhao" },
  { id: "odometro", nome: "Odômetro", grupo: "caminhao", atalho: "odometro" },
  { id: "desgaste", nome: "Desgaste (pior peça)", grupo: "desgaste", atalho: "desgaste" },
  { id: "dmotor", nome: "Desgaste do motor", grupo: "desgaste" },
  { id: "dcambio", nome: "Desgaste do câmbio", grupo: "desgaste" },
  { id: "dcabine", nome: "Desgaste da cabine", grupo: "desgaste" },
  { id: "dchassi", nome: "Desgaste do chassi", grupo: "desgaste" },
  { id: "drodas", nome: "Desgaste das rodas", grupo: "desgaste" },
  { id: "dreboque", nome: "Desgaste do reboque", grupo: "desgaste" },
];

const GRUPOS_INFO = {
  viagem: "Viagem",
  entrega: "Entrega",
  caminhao: "Caminhão",
  desgaste: "Desgaste",
};

// ---------------------------------------------------------------- dials

/**
 * Dials. Girar para a direita = `dir`, esquerda = `esq`, apertar = `apertar`, tocar na tela = `tocar`.
 * Valores são comandos do jogo; "info:<grupo>" e "lado" são tratados no plugin.
 */
const DIALS = [
  { id: "dialpiloto", nome: "Piloto automático", dir: "cruiectrlinc", esq: "cruiectrldec", apertar: "cruiectrl", tocar: "cruiectrlres",
    textos: { Rotate: "Ajustar velocidade", Push: "Liga/desliga", Touch: "Retomar" } },
  { id: "dialretarder", nome: "Retarder e freio motor", dir: "retarderup", esq: "retarderdown", apertar: "motorbrake", tocar: "retarderauto",
    textos: { Rotate: "Nível do retarder", Push: "Freio motor", Touch: "Retarder automático" } },
  { id: "dialluzes", nome: "Faróis", dir: "light", esq: "light", apertar: "hblight", tocar: "lighthorn",
    textos: { Rotate: "Trocar modo dos faróis", Push: "Farol alto", Touch: "Lampejo" } },
  { id: "diallimpador", nome: "Limpador", dir: "wipers", esq: "wipersback", apertar: "wipers", tocar: "wipers",
    textos: { Rotate: "Velocidade do limpador", Push: "Trocar", Touch: "Trocar" } },
  { id: "dialcamera", nome: "Câmera", dir: "camcycle", esq: "camcycle", apertar: "cam1", tocar: "camreset",
    textos: { Rotate: "Trocar câmera", Push: "Câmera da cabine", Touch: "Recentrar" } },
  { id: "dialradio", nome: "Rádio", dir: "radioup", esq: "radiodown", apertar: "radio", tocar: "radionext",
    textos: { Rotate: "Volume", Push: "Liga/desliga", Touch: "Próxima estação" } },
  { id: "dialcambio", nome: "Câmbio", dir: "gearup", esq: "geardown", apertar: "gear0", tocar: "transemi",
    textos: { Rotate: "Subir/descer marcha", Push: "Neutro", Touch: "Automático/manual" } },
  { id: "dialsuspensao", nome: "Suspensão", dir: "suspensao+", esq: "suspensao-", apertar: "suspreset", tocar: "suspreset",
    textos: { Rotate: "Subir/descer", Push: "Nivelar", Touch: "Nivelar" } },
  { id: "dialjanelas", nome: "Janelas", dir: "janela+", esq: "janela-", apertar: "lado", tocar: "lado",
    textos: { Rotate: "Abrir/fechar", Push: "Trocar lado", Touch: "Trocar lado" } },
  { id: "dialinfo", nome: "Informações", dir: "proximo", esq: "anterior", apertar: "proximo", tocar: "primeiro",
    textos: { Rotate: "Trocar informação", Push: "Próxima", Touch: "Voltar ao início" } },
];

module.exports = { GRUPOS, COMANDOS, POR_CMD, CAMPOS, GRUPOS_INFO, DIALS };
