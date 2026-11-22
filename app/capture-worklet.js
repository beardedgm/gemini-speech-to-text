// Audio thread: hands each 128-frame block of mic samples to capture.js.
registerProcessor('gstt-tap', class extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
});
