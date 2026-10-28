// Named jobs Butler can hand to a coding agent. A recipe fixes the agent, the
// working folder and the framing; the spoken request fills in the task.
const RECIPES = {
  orchestrate: {
    describe: 'A lead agent that plans the job and fans pieces out to parallel subagents. Use for big multi-part work.',
    cli: 'claude',
    model: 'opus',
    prompt: ({ task, workers }) => [
      `You are the lead agent on this job. Plan it, then delegate independent pieces in parallel to the "${workers || 'opus-medium'}" subagent (Agent/Task tool, subagent_type "${workers || 'opus-medium'}"). If that subagent type does not exist, use general-purpose subagents on the opus model at medium effort.`,
      'Integrate and verify their results yourself. Keep going without checking in; stop and ask Josh only when a decision is truly his (spending money, deleting data, choosing between real product options, credentials). When you do ask, ask one clear question.',
      'Finish with a summary of at most five lines: what changed, where, and anything Josh must do.',
      '',
      `Job: ${task}`,
    ].join('\n'),
  },

  mole_animate: {
    describe: 'Animate something with the MOLE studio pipeline (motion preview, paint, preview sheet).',
    cli: 'claude',
    model: 'opus',
    cwd: '{mole}/art/studio',
    prompt: ({ task }) => [
      'You are in the MOLE studio folder (art/studio). Read README.md here and ../../MEMORY.md before anything else.',
      'Pipeline: `uv run studio.py motion <name>` renders a bare-skeleton preview (no API cost). `uv run studio.py paint <motion> <character> --gen` paints it with the image model. `uv run studio.py preview <character> [clips]` writes work/preview/<character>/index.html plus GIFs.',
      'Rules: Josh approves a bare skeleton before any painting, so render the motion preview first, open the GIF or grid for him, and ask before --gen. Never install into content/sprites or wire anything into the game unless he asks.',
      'Finish by printing the absolute paths of the previews you produced.',
      '',
      `Request: ${task}`,
    ].join('\n'),
  },

  model_3d: {
    describe: 'Model something in 3D with Blender (headless) and render views. Returns PNG renders plus .blend and .glb files.',
    cli: 'claude',
    model: 'opus',
    cwd: '{renders}/{slug}',
    prompt: ({ task, blender }) => [
      `Build a 3D model and renders for this request. Blender is at: ${blender || 'blender'} (run it headless: \`"<blender>" -b -P build.py\`).`,
      'Write build.py in this folder with the Blender Python API: model the object with clean topology and real-world scale, give it materials, light it with a three-point rig or an HDRI-free sky, and render with Cycles (GPU, OptiX if available, 128 samples, denoise).',
      'Render 4 views to renders/: three-quarter hero, front, side, top, 1600x1200 PNG. Save model.blend and export model.glb.',
      'Look at the renders yourself (read the PNGs) and iterate on the script until the object reads clearly and looks good. Three iterations at most unless something is badly wrong.',
      'If the object is a mechanical part that needs exact dimensions and a FreeCAD MCP server is connected, you may use FreeCAD instead and export renders with its view tools.',
      'Finish by printing the absolute paths of the renders.',
      '',
      `Request: ${task}`,
    ].join('\n'),
  },

  research: {
    describe: 'Deep web research written up as a markdown report.',
    cli: 'claude',
    model: 'opus',
    cwd: '{renders}/../research',
    prompt: ({ task }) => [
      'Research this thoroughly on the web. Prefer primary sources and note dates. Write the report to a markdown file in this folder named after the topic, with a five-line summary on top and sources at the bottom.',
      'Finish by printing the report path and the five-line summary.',
      '',
      `Question: ${task}`,
    ].join('\n'),
  },
};

function slugify(text) {
  return String(text || 'job').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'job';
}

// Fills {mole}, {renders}, {slug} style placeholders from config paths.
function fillPath(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

function listRecipes() {
  return Object.entries(RECIPES).map(([name, r]) => ({ name, describe: r.describe }));
}

module.exports = { RECIPES, listRecipes, slugify, fillPath };
