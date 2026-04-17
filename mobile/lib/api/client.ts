/**
 * API 共通エラー + fetch ヘルパ。
 * 各エンドポイント固有のロジックは同階層の periodic.ts / chat.ts / plan.ts 等へ。
 */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, `POST ${url} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(res.status, `GET ${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

/** FormData 用: file を RN スタイル (uri + name + type) で添付する。 */
export function attachFile(form: FormData, imageUri: string): void {
  const filename = imageUri.split("/").pop() ?? "photo.jpg";
  form.append("file", {
    uri: imageUri,
    name: filename,
    type: "image/jpeg",
  } as unknown as Blob);
}
