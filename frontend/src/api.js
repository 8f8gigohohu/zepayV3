export class ApiError extends Error {
  constructor(message, status, code = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  if (!response.ok) {
    const details = Array.isArray(payload?.detail)
      ? payload.detail.map((item) => item.msg || item.type).join(', ')
      : payload?.detail;
    throw new ApiError(
      payload?.error || details || payload?.message || `Request failed (${response.status})`,
      response.status,
      payload?.code || null,
    );
  }
  return payload;
}

export function wsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/ws`;
}
