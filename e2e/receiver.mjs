// Throwaway afferent.page/1 + afferent.forget/1 receiver + test pages. Usage: node e2e/receiver.mjs [port]
// No CORS headers: only a granted host permission lets the extension reach it.
import http from 'node:http';

export function startReceiver(port = 0, token = 'test-token') {
  const records = [];
  const page = (title, body) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  const server = http.createServer((req, res) => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/hook')) {
      if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'auth' });
      if (req.method === 'GET') return json(200, { status: 'ok', accepts: ['afferent.page/1'] });
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let r;
        try { r = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
        if (r.schema === 'afferent.forget/1') {
          console.log('afferent.forget/1', (r.capture_ids || []).length + ' ids', r.from ? `${r.from}..${r.to}` : '');
          return json(200, { status: 'stored' });
        }
        const dup = records.some(x => x.capture_id === r.capture_id);
        if (!dup) { records.push(r); console.log('record', r.kind, r.url, r.dwell_seconds + 's', r.text.length + ' chars'); }
        json(200, { status: dup ? 'duplicate' : 'stored' });
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page(req.url === '/page.html' ? 'Afferent test page' : 'Somewhere else',
      req.url === '/page.html' ? 'MARKER-READ-TEXT lorem ipsum dolor sit amet.' : 'other'));
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, records, port: server.address().port, token })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port, token } = await startReceiver(Number(process.argv[2] || 8799));
  console.log(`receiver: http://127.0.0.1:${port}/hook  token: ${token}\ntest page: http://127.0.0.1:${port}/page.html`);
}
