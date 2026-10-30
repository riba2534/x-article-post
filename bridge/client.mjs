// Minimal HTTP client for the CLI. Uses node:http instead of fetch: drafts may take
// minutes and undici's default headers timeout (5 min) would cut them off.
import http from 'node:http';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function callApi({ port, token, method, path, body, timeoutMs = 11 * 60 * 1000 }) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let data;
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return reject(new ApiError(res.statusCode ?? 0, 'bad-response', 'Bridge returned non-JSON'));
          }
          if ((res.statusCode ?? 500) >= 400) {
            return reject(new ApiError(res.statusCode ?? 500, data?.error?.code ?? 'error', data?.error?.message ?? 'Request failed'));
          }
          resolve(data);
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new ApiError(504, 'timeout', 'No answer from the bridge')));
    req.on('error', (err) => {
      if (err instanceof ApiError) return reject(err);
      if (err.code === 'ECONNREFUSED') return reject(new ApiError(0, 'bridge-down', `Bridge is not running on 127.0.0.1:${port}. Start it with "xap serve".`));
      reject(err);
    });
    req.end(payload);
  });
}
