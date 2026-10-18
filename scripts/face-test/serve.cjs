// Serves the face test page, and the face from build/face at /models/.
const http = require('http'), fs = require('fs'), path = require('path')
const here = __dirname, models = path.join(here, '..', '..', 'build', 'face')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.vrm': 'model/gltf-binary' }
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x').pathname
  const file = u.startsWith('/models/') ? path.join(models, decodeURIComponent(u.slice(8))) : path.join(here, u === '/' ? 'index.html' : decodeURIComponent(u.slice(1)))
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
}).listen(Number(process.argv[2] || 8812), '127.0.0.1')
