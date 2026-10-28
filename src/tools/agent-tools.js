// The voice tools as a lanes.agent tool list, for the tool loops that run in
// the main process (phone text, turn-based voice). These have no eyes of their
// own, so look answers in words via the vision lane.
function agentTools({ schemas, execute, exclude = [], onResult = () => {} }) {
  return schemas().filter((s) => !exclude.includes(s.name)).map((s) => ({
    name: s.name,
    description: s.description,
    parameters: s.parameters,
    run: async (args) => {
      const out = await execute(s.name, s.name === 'look' ? { ...args, _describe: true } : args);
      onResult(s.name, args, out);
      return out;
    },
  }));
}

module.exports = { agentTools };
