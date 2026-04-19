import type { StageEvent } from "@/lib/types";

/** Hermes には DOMException が無いので、name="AbortError" の Error で代替。 */
function makeAbortError(tag: string): Error {
  const err = new Error(`${tag}: aborted`);
  err.name = "AbortError";
  return err;
}

/**
 * SSE ストリームの共通リーダー。
 * React Native の fetch は body streaming 非対応のため XMLHttpRequest で実装。
 * `readyState >= 3` で responseText を累積、`\n\n` 区切りで SSE イベントをパース。
 *
 * BE プロトコル:
 *   event: stage  data: {StageEvent...}
 *   event: done   data: {...}
 */
export function streamSSE(
  url: string,
  formData: FormData,
  onEvent: (ev: StageEvent) => void,
  tag: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError(tag));
      return;
    }

    const xhr = new XMLHttpRequest();
    const t0 = Date.now();
    let lastIndex = 0;
    let buf = "";
    let firstChunkLogged = false;
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      try {
        xhr.abort();
      } catch {
        // ignore
      }
      signal?.removeEventListener("abort", onAbort);
      reject(makeAbortError(tag));
    };
    signal?.addEventListener("abort", onAbort);

    const flushBuf = () => {
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);

        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;

        if (event === "done") {
          console.log(`[${tag}] done ${Date.now() - t0}ms`);
          continue;
        }
        if (event === "stage") {
          try {
            const parsed = JSON.parse(data) as StageEvent;
            console.log(
              `[${tag}] stage${parsed.stage} j=${parsed.judgment} esc=${parsed.escalated} blocks=${parsed.blocks?.length ?? 0}`,
            );
            onEvent(parsed);
          } catch (e) {
            console.warn(`[${tag}] parse error:`, e, data.slice(0, 200));
          }
        }
      }
    };

    xhr.open("POST", url);
    xhr.setRequestHeader("Accept", "text/event-stream");

    xhr.onreadystatechange = () => {
      if (aborted) return;
      if (xhr.readyState >= 3 && xhr.status === 200) {
        if (!firstChunkLogged) {
          console.log(`[${tag}] first chunk ${Date.now() - t0}ms`);
          firstChunkLogged = true;
        }
        buf += xhr.responseText.substring(lastIndex);
        lastIndex = xhr.responseText.length;
        flushBuf();
      }
      if (xhr.readyState === 4) {
        signal?.removeEventListener("abort", onAbort);
        if (xhr.status === 200) {
          flushBuf();
          resolve();
        } else {
          reject(
            new Error(`${tag} failed: ${xhr.status} ${xhr.responseText.slice(0, 200)}`),
          );
        }
      }
    };

    xhr.onerror = () => {
      if (aborted) return;
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`${tag}: network error`));
    };
    xhr.send(formData);
  });
}
