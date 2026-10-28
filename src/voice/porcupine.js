// Fully local "Butler" wake word with Picovoice Porcupine: train the keyword in
// Picovoice Console (free personal tier), download the Windows .ppn, and set
// wake.engine "porcupine" plus wake.porcupineKeywordPath. Nothing leaves the PC
// until the word is heard. Both packages are optional dependencies.
function createPorcupine({ config, onWake, log = () => {} }) {
  let recorder = null;
  let running = false;
  let paused = false;

  async function start() {
    const key = process.env.PICOVOICE_ACCESS_KEY;
    if (!key || !config.wake.porcupineKeywordPath) {
      log('porcupine: PICOVOICE_ACCESS_KEY or wake.porcupineKeywordPath missing');
      return false;
    }
    let Porcupine, PvRecorder;
    try {
      ({ Porcupine } = require('@picovoice/porcupine-node'));
      ({ PvRecorder } = require('@picovoice/pvrecorder-node'));
    } catch (err) {
      log(`porcupine: packages not installed (${err.message})`);
      return false;
    }
    const engine = new Porcupine(key, [config.wake.porcupineKeywordPath], [config.wake.porcupineSensitivity || 0.6]);
    recorder = new PvRecorder(engine.frameLength, -1);
    recorder.start();
    running = true;
    (async () => {
      let last = 0;
      while (running) {
        const frame = await recorder.read();
        if (paused) continue;
        if (engine.process(frame) >= 0 && Date.now() - last > 2000) {
          last = Date.now();
          onWake({ command: '' });
        }
      }
      recorder.release();
      engine.release();
    })().catch((err) => log(`porcupine loop: ${err.message}`));
    return true;
  }

  return {
    start,
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    stop: () => { running = false; },
  };
}

module.exports = { createPorcupine };
