const fs = require('fs');

const MIME_VIDEO = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/mp4' };

// Serves a file with HTTP Range support so the player can seek and start quickly.
function serveRange(req, res, file, extraHeaders = {}) {
  const { size } = fs.statSync(file);
  const ext = require('path').extname(file).toLowerCase();
  const base = {
    'Accept-Ranges': 'bytes',
    'Content-Type': MIME_VIDEO[ext] || 'application/octet-stream',
    'Cache-Control': 'private, no-store',
    ...extraHeaders
  };

  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { ...base, 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m || (m[1] === '' && m[2] === '')) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }

  let start;
  let end;
  if (m[1] === '') {
    // Suffix range: last N bytes
    const suffix = parseInt(m[2], 10);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }

  if (start >= size || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }

  res.writeHead(206, {
    ...base,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

module.exports = { serveRange };
