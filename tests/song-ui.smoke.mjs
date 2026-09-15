import { resolve } from 'node:path';

const port = process.argv[2] || '9334';
const scorePath = resolve(process.argv[3] || '../Files/Anisuthide_Yaako_Indu.dng.json');
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
const target = targets.find(item => item.type === 'page' && item.url.includes('/src/renderer/index.html'));
if (!target) throw new Error('No Electron renderer target found.');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolveOpen, reject) => {
  socket.addEventListener('open', resolveOpen, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let messageId = 0;
function command(method, params = {}) {
  const id = ++messageId;
  return new Promise((resolveReply, reject) => {
    const onMessage = event => {
      const reply = JSON.parse(event.data);
      if (reply.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (reply.error) reject(new Error(reply.error.message));
      else if (reply.result.exceptionDetails) reject(new Error(reply.result.exceptionDetails.exception?.description
        || reply.result.exceptionDetails.text));
      else resolveReply(reply.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

await command('DOM.enable');
const documentNode = await command('DOM.getDocument');
const input = await command('DOM.querySelector', {
  nodeId: documentNode.root.nodeId,
  selector: '#fileInput',
});
await command('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [scorePath] });

const evaluated = await command('Runtime.evaluate', {
  expression: `(async () => {
    document.getElementById('fileInput').dispatchEvent(new Event('change'));
    const loadDeadline = Date.now() + 5000;
    while (document.getElementById('titleVal').textContent !== 'Anisuthide Yaako Indu'
      && Date.now() < loadDeadline) await new Promise(resolve => setTimeout(resolve, 50));

    document.getElementById('playBtn').click();
    await new Promise(resolve => setTimeout(resolve, 350));
    const highlightedDuringPlayback = Boolean(document.querySelector('[data-active="1"]'));
    document.getElementById('bStop').click();

    window.__midiAlert = null;
    window.alert = message => { window.__midiAlert = message; };
    URL.createObjectURL = blob => {
      window.__midiBlob = blob;
      return 'blob:midi-smoke-test';
    };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function () {
      window.__midiDownload = window.__midiBlob.arrayBuffer().then(buffer => ({
        name: this.download,
        size: buffer.byteLength,
        header: new TextDecoder().decode(buffer.slice(0, 4)),
      }));
    };
    document.getElementById('bMidi').click();
    const download = window.__midiDownload ? await window.__midiDownload : null;
    return {
      title: document.getElementById('titleVal').textContent,
      midiButtonPresent: Boolean(document.getElementById('bMidi')),
      highlightedDuringPlayback,
      alert: window.__midiAlert,
      download,
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});

socket.close();
const value = evaluated.result.value;
if (value.title !== 'Anisuthide Yaako Indu' || !value.midiButtonPresent
  || !value.highlightedDuringPlayback || value.alert || value.download?.header !== 'MThd') {
  throw new Error(`Song UI smoke test failed: ${JSON.stringify(value)}`);
}
console.log(JSON.stringify(value, null, 2));
