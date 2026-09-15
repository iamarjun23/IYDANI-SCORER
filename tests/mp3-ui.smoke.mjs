const port = process.argv[2] || '9333';
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
const target = targets.find(item => item.type === 'page' && item.url.includes('/src/renderer/index.html'));
if (!target) throw new Error('No Electron renderer target found.');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let messageId = 0;
function evaluate(expression) {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    const onMessage = event => {
      const reply = JSON.parse(event.data);
      if (reply.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (reply.error) reject(new Error(reply.error.message));
      else if (reply.result.exceptionDetails) reject(new Error(reply.result.exceptionDetails.exception?.description
        || reply.result.exceptionDetails.text));
      else resolve(reply.result.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
}

const result = await evaluate(`(async () => {
  window.__mp3Alert = null;
  window.alert = message => { window.__mp3Alert = message; };
  URL.createObjectURL = blob => {
    window.__mp3Blob = blob;
    return 'blob:smoke-test';
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {
    window.__mp3Download = window.__mp3Blob.arrayBuffer()
      .then(buffer => ({
        name: this.download,
        size: buffer.byteLength,
        header: [...new Uint8Array(buffer.slice(0, 2))],
      }));
  };

  document.getElementById('bOpen').click();
  await new Promise(resolve => setTimeout(resolve, 50));
  document.querySelector('[data-pre]')?.click();
  await new Promise(resolve => setTimeout(resolve, 50));
  document.getElementById('bMp3').click();

  const deadline = Date.now() + 30000;
  while (document.getElementById('bMp3').disabled && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const download = window.__mp3Download ? await window.__mp3Download : null;
  return {
    buttonPresent: Boolean(document.getElementById('bMp3')),
    encoderPresent: typeof window.lamejs?.Mp3Encoder === 'function',
    alert: window.__mp3Alert,
    download,
  };
})()`);

socket.close();
const value = result.value;
if (!value?.buttonPresent || !value.encoderPresent || value.alert || !value.download) {
  throw new Error(`MP3 UI smoke test failed: ${JSON.stringify(value)}`);
}
if (value.download.size < 1000 || value.download.header[0] !== 255 || (value.download.header[1] & 224) !== 224) {
  throw new Error(`Downloaded data is not a valid MP3: ${JSON.stringify(value.download)}`);
}
console.log(JSON.stringify(value, null, 2));
