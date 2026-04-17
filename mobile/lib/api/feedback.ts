import type { components } from "./schema";

type FeedbackRequest = components["schemas"]["FeedbackRequest"];

/** /guide/feedback 送信。失敗は握りつぶして warn ログのみ (UX に影響させない)。 */
export function submitFeedback(
  apiUrl: string,
  payload: Omit<FeedbackRequest, "target_id" | "session_id"> & {
    target_id?: string;
    session_id?: string;
  },
): Promise<void> {
  return fetch(`${apiUrl}/guide/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then(() => undefined)
    .catch((err) => {
      console.warn("[Feedback] send failed:", err);
    });
}
