"use strict";
/**
 * O que cada tecla e cada dial mostra. Funções puras: recebem o status da ponte e devolvem a
 * `view` que o render.js (R.clean) desenha: {label, value, sub, level, accent, pct}.
 *
 * Regra da casa: sem dado, a tecla diz o motivo ("abra o jogo", "sem entrega"); nunca
 * mostra número inventado.
 */

const C = require("./catalog");

const DIAS = ["SEG", "TER", "QUA", "QUI", "SEX", "SÁB", "DOM"];
const OFF = "offline";

// ---------------------------------------------------------------- unidades

function unidades(status) {
  const game = status && status.info && status.info.game;
  const ats = game === "ats";
  return {
    ats,
    vel: ats ? "mph" : "km/h",
    velFator: ats ? 2.2369363 : 3.6, // m/s -> mph | km/h
    dist: ats ? "mi" : "km",
    distFator: ats ? 0.621371 : 1, // km -> mi | km
    vol: ats ? "gal" : "L",
    volFator: ats ? 0.264172 : 1,
    moeda: ats ? "$" : "€",
  };
}

const r0 = (n) => Math.round(Number(n) || 0);
const milhar = (n) => r0(n).toLocaleString("pt-BR");

function hhmm(minutos) {
  const m = Math.max(0, r0(minutos));
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  return `${h}h${mm}`;
}

function relogio(minutosDesdeInicio) {
  const m = Math.max(0, r0(minutosDesdeInicio));
  const dia = DIAS[Math.floor(m / 1440) % 7];
  const h = String(Math.floor((m % 1440) / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return { hora: `${h}:${mm}`, dia };
}

function textoMarcha(t) {
  const g = Number(t.displayedGear ?? t.gear ?? 0);
  if (g > 0) return String(g);
  if (g < 0) return `R${-g}`;
  return "N";
}

function modoFarois(t) {
  if (t.highBeam) return "ALTO";
  if (t.lowBeam) return "BAIXO";
  if (t.parkingLight) return "POSIÇÃO";
  return "DESLIGADO";
}

// ---------------------------------------------------------------- estado geral

/** Sem jogo, sem telemetria: a mesma resposta em todo lugar. */
function semJogo(status, label) {
  if (!status || !status.connected) return { label, value: "—", sub: "abra o jogo", level: OFF };
  if (!status.state) return { label, value: "…", sub: "aguardando o jogo", level: OFF };
  return null;
}

// ---------------------------------------------------------------- estados dos comandos

/** Cada leitor devolve {on, value, sub?} ou null quando o jogo não informa aquele estado. */
const ESTADOS = {
  motor: (t) => ({ on: t.engine, value: t.engine ? "LIGADO" : "DESLIGADO" }),
  eletrica: (t) => ({ on: t.electric, value: t.electric ? "LIGADA" : "DESLIGADA" }),
  freioMao: (t) => ({ on: t.parkingBrake, value: t.parkingBrake ? "PUXADO" : "SOLTO" }),
  freioMotor: (t) => ({ on: t.motorBrake, value: t.motorBrake ? "LIGADO" : "DESLIGADO" }),
  retarder: (t) =>
    t.retarderSteps > 0
      ? { on: t.retarder > 0, value: t.retarder > 0 ? `${t.retarder}/${t.retarderSteps}` : "DESLIGADO" }
      : { on: false, value: "SEM RET." },
  piloto: (t, u) =>
    t.cruise > 0.1
      ? { on: true, value: `${r0(t.cruise * u.velFator)}`, sub: u.vel }
      : { on: false, value: "DESLIGADO" },
  // O pisca acende no ritmo da lâmpada (vem da telemetria a até 10 Hz).
  piscaEsq: (t) => ({ on: t.lblinkerLight, value: "◀", sub: t.lblinker ? "ligado" : "" }),
  piscaDir: (t) => ({ on: t.rblinkerLight, value: "▶", sub: t.rblinker ? "ligado" : "" }),
  alerta: (t) => ({ on: t.hazard && (t.lblinkerLight || t.rblinkerLight), value: "ALERTA", sub: t.hazard ? "ligado" : "" }),
  farois: (t) => ({ on: t.parkingLight || t.lowBeam || t.highBeam, value: modoFarois(t) }),
  farolAlto: (t) => ({ on: t.highBeam, value: t.highBeam ? "LIGADO" : "DESLIGADO" }),
  giroflex: (t) => ({ on: t.beacon, value: t.beacon ? "LIGADO" : "DESLIGADO" }),
  limpador: (t) => ({ on: t.wipers, value: t.wipers ? "LIGADO" : "DESLIGADO" }),
  marcha: (t) => ({ on: true, value: textoMarcha(t) }),
  reboque: (t, u, st) => ({ on: st.trailer.connected, value: st.trailer.connected ? "ENGATADO" : "SOLTO" }),
  diferencial: (t) => ({ on: t.diffLock, value: t.diffLock ? "TRAVADO" : "LIVRE" }),
  eixo: (t) => ({ on: t.liftAxle, value: t.liftAxle ? "ERGUIDO" : "NO CHÃO" }),
  eixoReboque: (t) => ({ on: t.trailerLiftAxle, value: t.trailerLiftAxle ? "ERGUIDO" : "NO CHÃO" }),
};

/** Tecla de comando (atalho ou a genérica "comando"). */
function comandoView(status, cmd, settings = {}) {
  const c = C.POR_CMD.get(cmd);
  if (!c) return { label: "COMANDO", value: "?", sub: "escolha no inspetor", level: OFF };
  const g = C.GRUPOS[c.grupo] || {};
  const label = (settings.titulo || c.nome).toUpperCase();
  const dica = c.tecla ? `tecla ${c.tecla}` : "";

  const falta = semJogo(status, label);
  if (falta) return falta;
  if (status.info && status.info.input === false) return { label, value: c.curto, sub: "ponte sem entrada", level: "warn" };

  const u = unidades(status);
  const leitor = c.estado && ESTADOS[c.estado];
  if (leitor) {
    const t = status.state.truck || {};
    const e = leitor(t, u, status.state) || {};
    return {
      label,
      value: e.value || c.curto,
      sub: e.sub || dica,
      level: e.on ? "safe" : OFF,
      accent: g.cor,
    };
  }
  return { label, value: c.curto, sub: c.modo === "segurar" ? "segure" : dica, level: "safe", accent: g.cor };
}

// ---------------------------------------------------------------- campos de painel

function pctDe(v, total) {
  return total > 0 ? Math.max(0, Math.min(100, (v / total) * 100)) : null;
}

function nivelDesgaste(p) {
  if (p >= 40) return "danger";
  if (p >= 15) return "warn";
  return "safe";
}

const ACC = { viagem: "#5aa9ff", entrega: "#4dd0e1", caminhao: "#ef985d", desgaste: "#ffb454" };

/** Calcula um campo. Devolve a view completa (label incluído). */
function campo(status, id) {
  const def = C.CAMPOS.find((x) => x.id === id) || { id, nome: id, grupo: "viagem" };
  const label = def.nome.toUpperCase();
  const falta = semJogo(status, label);
  if (falta) return falta;

  const st = status.state;
  const t = st.truck || {};
  const nav = st.nav || {};
  const job = st.job || {};
  const u = unidades(status);
  const accent = ACC[def.grupo];
  const v = (value, sub = "", level = "safe", pct) => ({ label, value: String(value), sub, level, accent, pct });
  const pausa = st.paused ? "pausado" : "";

  switch (id) {
    case "velocidade": {
      const vel = Math.abs(t.speed || 0) * u.velFator;
      const lim = (nav.speedLimit || 0) * u.velFator;
      let level = "safe";
      if (lim > 0 && vel > lim + 15) level = "danger";
      else if (lim > 0 && vel > lim + 5) level = "warn";
      return v(r0(vel), lim > 0 ? `${u.vel} · limite ${r0(lim)}` : u.vel, level);
    }
    case "limite": {
      const lim = (nav.speedLimit || 0) * u.velFator;
      return lim > 0 ? v(r0(lim), u.vel) : v("—", "sem placa", OFF);
    }
    case "distancia": {
      const km = (nav.distance || 0) / 1000;
      if (km <= 0.05) return v("—", "sem rota", OFF);
      const d = km * u.distFator;
      return v(d >= 100 ? r0(d) : d.toFixed(1), u.dist);
    }
    case "chegada": {
      const s = nav.time || 0;
      if (s <= 0) return v("—", "sem rota", OFF);
      return v(hhmm(s / 60), "de viagem");
    }
    case "horario": {
      const { hora, dia } = relogio(st.gameTime);
      return v(hora, pausa || dia);
    }
    case "descanso": {
      const m = st.restStop;
      if (!(m > 0)) return v("AGORA", "pare para dormir", "danger");
      return v(hhmm(m), "até dormir", m < 15 ? "danger" : m < 60 ? "warn" : "safe");
    }
    case "destino":
      return job.active ? v(job.destinationCity || "—", job.destinationCompany || "") : v("—", "sem entrega", OFF);
    case "carga": {
      if (!job.active) return v("—", "sem entrega", OFF);
      const ton = (job.cargoMass || 0) / 1000;
      return v(job.cargo || "—", ton > 0 ? `${ton.toFixed(1)} t` : "");
    }
    case "prazo": {
      if (!job.active || !job.deliveryTime) return v("—", "sem prazo", OFF);
      const resta = job.deliveryTime - st.gameTime;
      if (resta < 0) return v("ATRASADO", hhmm(-resta), "danger");
      return v(hhmm(resta), "para entregar", resta < 60 ? "danger" : resta < 180 ? "warn" : "safe");
    }
    case "renda":
      return job.active ? v(`${u.moeda} ${milhar(job.income)}`, job.plannedKm ? `${milhar(job.plannedKm * u.distFator)} ${u.dist}` : "") : v("—", "sem entrega", OFF);
    case "danocarga": {
      if (!job.active) return v("—", "sem entrega", OFF);
      const p = (job.cargoDamage || 0) * 100;
      return v(`${p.toFixed(p < 10 ? 1 : 0)}%`, "da carga", p >= 10 ? "danger" : p >= 2 ? "warn" : "safe", p);
    }
    case "evento": {
      const ev = st.event || {};
      if (!ev.seq) return v("—", "nada ainda", OFF);
      const nomes = {
        "job.delivered": ["ENTREGUE", "safe"],
        "job.cancelled": ["CANCELADA", "warn"],
        "player.fined": ["MULTA", "danger"],
        "player.tollgate.paid": ["PEDÁGIO", "safe"],
        "player.use.ferry": ["BALSA", "safe"],
        "player.use.train": ["TREM", "safe"],
      };
      const [nome, level] = nomes[ev.id] || [ev.id, "safe"];
      const valor = ev.amount ? `${u.moeda} ${milhar(ev.amount)}` : "";
      return v(nome, [valor, ev.detail].filter(Boolean).join(" · "), level);
    }
    case "combustivel": {
      const cap = t.fuelCapacity || 0;
      const p = pctDe(t.fuel, cap);
      const lit = (t.fuel || 0) * u.volFator;
      const nivel = t.fuelWarning ? "danger" : p !== null && p < 25 ? "warn" : "safe";
      return v(p !== null ? `${r0(p)}%` : `${r0(lit)} ${u.vol}`, `${r0(lit)} ${u.vol}`, nivel, p ?? undefined);
    }
    case "autonomia": {
      const d = (t.fuelRange || 0) * u.distFator;
      return v(milhar(d), u.dist, t.fuelWarning ? "danger" : "safe");
    }
    case "consumo": {
      const lkm = t.fuelAvg || 0;
      if (lkm <= 0) return v("—", "sem média", OFF);
      return u.ats ? v((1 / (lkm * 0.264172 / 0.621371)).toFixed(1), "mpg") : v((lkm * 100).toFixed(1), "L/100 km");
    }
    case "adblue": {
      const p = pctDe(t.adblue, t.adblueCapacity);
      if (p === null) return v("—", "sem AdBlue", OFF);
      return v(`${r0(p)}%`, `${r0(t.adblue * u.volFator)} ${u.vol}`, t.adblueWarning ? "danger" : p < 20 ? "warn" : "safe", p);
    }
    case "rpm": {
      const p = pctDe(t.rpm, t.rpmLimit);
      return v(milhar(t.rpm), "rpm", p !== null && p > 92 ? "warn" : "safe", p ?? undefined);
    }
    case "marcha":
      return v(textoMarcha(t), t.gearsForward ? `de ${t.gearsForward} · ${milhar(t.rpm)} rpm` : `${milhar(t.rpm)} rpm`);
    case "ar":
      return v(r0(t.air), "psi", t.airEmergency ? "danger" : t.airWarning ? "warn" : "safe");
    case "oleo":
      return v(`${r0(t.oilTemp)}°`, `óleo · ${r0(t.oilPressure)} psi`, t.oilWarning ? "danger" : "safe");
    case "agua":
      return v(`${r0(t.waterTemp)}°`, "água", t.waterWarning ? "danger" : "safe");
    case "bateria":
      return v(`${(t.battery || 0).toFixed(1)} V`, "bateria", t.batteryWarning ? "danger" : "safe");
    case "odometro":
      return v(milhar((t.odometer || 0) * u.distFator), u.dist);
    case "desgaste": {
      const pecas = [
        ["motor", t.wearEngine], ["câmbio", t.wearTransmission], ["cabine", t.wearCabin],
        ["chassi", t.wearChassis], ["rodas", t.wearWheels],
        ["reboque", Math.max(st.trailer.wearBody || 0, st.trailer.wearChassis || 0, st.trailer.wearWheels || 0)],
      ];
      pecas.sort((a, b) => (b[1] || 0) - (a[1] || 0));
      const p = (pecas[0][1] || 0) * 100;
      return v(`${r0(p)}%`, pecas[0][0], nivelDesgaste(p), p);
    }
    case "dmotor":
    case "dcambio":
    case "dcabine":
    case "dchassi":
    case "drodas": {
      const k = { dmotor: "wearEngine", dcambio: "wearTransmission", dcabine: "wearCabin", dchassi: "wearChassis", drodas: "wearWheels" }[id];
      const p = (t[k] || 0) * 100;
      return v(`${r0(p)}%`, "desgaste", nivelDesgaste(p), p);
    }
    case "dreboque": {
      if (!st.trailer.connected) return v("—", "sem reboque", OFF);
      const p = Math.max(st.trailer.wearBody || 0, st.trailer.wearChassis || 0, st.trailer.wearWheels || 0) * 100;
      return v(`${r0(p)}%`, "desgaste", nivelDesgaste(p), p);
    }
    default:
      return v("?", "campo desconhecido", OFF);
  }
}

// ---------------------------------------------------------------- dials

function camposDoGrupo(grupo) {
  const lista = C.CAMPOS.filter((c) => c.grupo === grupo).map((c) => c.id);
  return lista.length ? lista : C.CAMPOS.filter((c) => c.grupo === "viagem").map((c) => c.id);
}

const LADOS = ["AMBAS", "ESQUERDA", "DIREITA"];

function dialView(status, action, settings = {}) {
  const d = C.DIALS.find((x) => x.id === action);
  if (!d) return { label: "DIAL", value: "?", sub: "ação desconhecida", level: OFF };

  if (action === "dialinfo") {
    const lista = camposDoGrupo(settings.grupo || "viagem");
    const i = ((Number(settings.cycleIndex) || 0) % lista.length + lista.length) % lista.length;
    const view = campo(status, lista[i]);
    const grupo = C.GRUPOS_INFO[settings.grupo || "viagem"] || "Viagem";
    return { ...view, label: `${grupo.toUpperCase()} · ${view.label}`, sub: view.sub ? `${view.sub}  ${i + 1}/${lista.length}` : `${i + 1}/${lista.length}` };
  }

  const label = d.nome.toUpperCase();
  const falta = semJogo(status, label);
  if (falta) return falta;
  const st = status.state;
  const t = st.truck || {};
  const u = unidades(status);
  const vel = r0(Math.abs(t.speed || 0) * u.velFator);
  const lim = r0((st.nav && st.nav.speedLimit ? st.nav.speedLimit : 0) * u.velFator);

  switch (action) {
    case "dialpiloto":
      return t.cruise > 0.1
        ? { label, value: `${r0(t.cruise * u.velFator)} ${u.vel}`, sub: `agora ${vel}${lim ? ` · limite ${lim}` : ""}`, level: "safe", accent: "#ef985d" }
        : { label, value: "DESLIGADO", sub: `agora ${vel} ${u.vel} · aperte para ligar`, level: OFF };
    case "dialretarder": {
      const fm = t.motorBrake ? "freio motor ligado" : "freio motor desligado";
      if (!(t.retarderSteps > 0)) return { label, value: "SEM RETARDER", sub: fm, level: t.motorBrake ? "safe" : OFF, accent: "#ef985d" };
      return {
        label,
        value: t.retarder > 0 ? `${t.retarder}/${t.retarderSteps}` : "DESLIGADO",
        sub: fm,
        level: t.retarder > 0 || t.motorBrake ? "safe" : OFF,
        accent: "#ef985d",
        pct: pctDe(t.retarder, t.retarderSteps),
      };
    }
    case "dialluzes": {
      const extras = [t.beacon && "giroflex", t.auxFront && "aux frente", t.auxRoof && "aux teto"].filter(Boolean);
      return {
        label,
        value: modoFarois(t),
        sub: extras.length ? extras.join(" · ") : "aperte: farol alto",
        level: t.parkingLight || t.lowBeam || t.highBeam ? "safe" : OFF,
        accent: "#ffd166",
      };
    }
    case "diallimpador":
      return { label, value: t.wipers ? "LIGADO" : "DESLIGADO", sub: "gire para trocar a velocidade", level: t.wipers ? "safe" : OFF, accent: "#ffd166" };
    case "dialcamera":
      return { label, value: "GIRE", sub: "aperte: cabine · toque: centro", level: "safe", accent: "#5aa9ff" };
    case "dialradio":
      return { label, value: "VOLUME", sub: "aperte: liga · toque: estação", level: "safe", accent: "#b48cff" };
    case "dialcambio": {
      const p = pctDe(t.rpm, t.rpmLimit);
      return {
        label,
        value: textoMarcha(t),
        sub: `${milhar(t.rpm)} rpm · aperte: neutro`,
        level: p !== null && p > 92 ? "warn" : "safe",
        accent: "#76b900",
        pct: p ?? undefined,
      };
    }
    case "dialsuspensao":
      return { label, value: "↕", sub: "gire: subir/descer · aperte: nivelar", level: "safe", accent: "#4dd0e1" };
    case "dialjanelas": {
      const lado = LADOS[(Number(settings.lado) || 0) % LADOS.length];
      return { label, value: lado, sub: "gire: abrir/fechar · aperte: lado", level: "safe", accent: "#b48cff" };
    }
    default:
      return { label, value: "?", sub: "", level: OFF };
  }
}

/** Comandos que um giro/toque do dial dispara. `extra` traz o lado das janelas. */
function dialComandos(action, gesto, settings = {}) {
  const d = C.DIALS.find((x) => x.id === action);
  if (!d) return [];
  const alvo = d[gesto];
  if (!alvo) return [];
  if (alvo === "suspensao+") return ["frontsuspup", "rearsuspup"];
  if (alvo === "suspensao-") return ["frontsuspdwn", "rearsuspdwn"];
  if (alvo === "janela+" || alvo === "janela-") {
    const lado = (Number(settings.lado) || 0) % LADOS.length;
    const abrir = alvo === "janela+";
    const esq = abrir ? "lwinopen" : "lwinclose";
    const dir = abrir ? "rwinopen" : "rwinclose";
    return lado === 1 ? [esq] : lado === 2 ? [dir] : [esq, dir];
  }
  if (C.POR_CMD.has(alvo)) return [alvo];
  return []; // proximo/anterior/primeiro/lado: tratados no plugin
}

module.exports = { comandoView, campo, dialView, dialComandos, camposDoGrupo, unidades, ESTADOS, LADOS, relogio, textoMarcha };
