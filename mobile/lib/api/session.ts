import { postJson } from "./client";

export function startSession(apiUrl: string): Promise<{ session_id: string }> {
  return postJson<{ session_id: string }>(`${apiUrl}/guide/session/start`, {});
}
