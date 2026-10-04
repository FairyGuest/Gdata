export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export async function api<T = unknown>(
  base: string,
  method: string,
  path: string,
  payload?: unknown
): Promise<ApiResponse<T>> {
  const res = await fetch(base + path, {
    method,
    headers: payload === undefined ? {} : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T) : (undefined as T);
  return { status: res.status, body };
}

