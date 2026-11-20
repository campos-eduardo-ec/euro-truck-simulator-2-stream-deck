/* Ligação comum dos inspetores: conecta, guarda settings e pede o catálogo ao plugin. */
window.PI = (function () {
  let ws = null, uuid = null, actionInfo = null, settings = {}, onSettings = () => {}, onCatalogo = () => {};
  function save(novas) {
    settings = { ...settings, ...novas };
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ event: "setSettings", context: uuid, payload: settings }));
  }
  window.connectElgatoStreamDeckSocket = function (inPort, inUUID, inRegisterEvent, inInfo, inActionInfo) {
    uuid = inUUID;
    actionInfo = JSON.parse(inActionInfo);
    settings = (actionInfo.payload && actionInfo.payload.settings) || {};
    ws = new WebSocket("ws://127.0.0.1:" + inPort);
    ws.onopen = () => {
      ws.send(JSON.stringify({ event: inRegisterEvent, uuid: inUUID }));
      ws.send(JSON.stringify({ event: "sendToPlugin", context: uuid, action: actionInfo.action, payload: { pedido: "catalogo" } }));
      onSettings(settings, actionInfo.action);
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.event === "didReceiveSettings") { settings = (msg.payload && msg.payload.settings) || {}; onSettings(settings, actionInfo.action); }
        if (msg.event === "sendToPropertyInspector" && msg.payload && msg.payload.catalogo) onCatalogo(msg.payload, settings, actionInfo.action);
      } catch (e) { /* ignora */ }
    };
  };
  return {
    save,
    get settings() { return settings; },
    acao: () => (actionInfo ? actionInfo.action.replace("digital.astronauta.ets2.", "") : ""),
    onSettings: (fn) => { onSettings = fn; },
    onCatalogo: (fn) => { onCatalogo = fn; },
  };
})();
