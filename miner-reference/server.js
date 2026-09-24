// 本地测试服务：提供页面 + 接收挖矿结果（仅供开发测试用）
// 用法：node server.js  然后浏览器打开 http://127.0.0.1:8788/
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8788;

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/log') {
        console.log('LOG: ' + body);
        res.writeHead(200); res.end('ok');
      } else if (req.url === '/result') {
        console.log('RESULT: ' + body);
        res.writeHead(200); res.end('ok');
      } else {
        res.writeHead(404); res.end();
      }
    });
    return;
  }
  const urlPath = req.url.split('?')[0];
  const p = urlPath === '/' ? '/grinder.html' : urlPath;
  const file = path.join(__dirname, p.replace(/^\/+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log('listening on ' + PORT));
