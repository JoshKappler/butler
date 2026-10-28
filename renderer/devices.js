// Audio devices by the name Windows shows. The mic opens the saved input;
// every player and Sounds' context are routed to the saved output.
const Devices = (() => {
  const sinks = [];
  let sinkId = '';

  async function list(kind) {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === kind && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications');
  }

  async function idFor(kind, label) {
    if (!label) return '';
    const d = (await list(kind)).find((x) => x.label === label);
    return d ? d.deviceId : '';
  }

  const apply = (s) => s.setSinkId(sinkId).catch((err) => window.butler.log(`output device: ${err.message}`));

  return {
    names: async (kind) => (await list(kind)).map((d) => d.label),
    inputId: (label) => idFor('audioinput', label),
    async setOutput(label) {
      sinkId = await idFor('audiooutput', label);
      if (label && !sinkId) window.butler.log(`output device not found: ${label}`);
      for (const s of sinks) apply(s);
    },
    route(s) { sinks.push(s); if (sinkId) apply(s); },
  };
})();
