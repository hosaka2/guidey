import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";

/**
 * Gemma GGUF モデル (本体 + mmproj) のダウンロード + バージョン管理。
 * VLM 推論には 2 ファイル必要:
 *   - 本体重み (Q4_K_M 等)
 *   - mmproj (vision projector)
 */

export type ModelAsset = {
  url: string;
  filename: string;
};

export type ModelBundle = {
  id: string;
  version: string;
  main: ModelAsset;
  mmproj: ModelAsset;
};

// デフォルト: unsloth/gemma-4-E2B-it-GGUF Q4_K_M + F16 mmproj
export const DEFAULT_MODEL: ModelBundle = {
  id: "gemma-4-e2b-it-q4_k_m",
  version: "1",
  main: {
    url: "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf",
    filename: "gemma-4-E2B-it-Q4_K_M.gguf",
  },
  mmproj: {
    url: "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/mmproj-F16.gguf",
    filename: "mmproj-F16.gguf",
  },
};

const STORAGE_KEY = "guidey_edge_model_meta";

type ModelMeta = {
  id: string;
  version: string;
  main_path: string;
  mmproj_path: string;
  downloaded_at: string;
};

function modelDir(): string {
  return `${FileSystem.documentDirectory}models/`;
}

export function modelPaths(bundle: ModelBundle = DEFAULT_MODEL): {
  main: string;
  mmproj: string;
} {
  return {
    main: `${modelDir()}${bundle.main.filename}`,
    mmproj: `${modelDir()}${bundle.mmproj.filename}`,
  };
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(modelDir());
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(modelDir(), { intermediates: true });
  }
}

async function loadMeta(): Promise<ModelMeta | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ModelMeta;
  } catch {
    return null;
  }
}

async function saveMeta(meta: ModelMeta): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(meta));
}

export async function isModelReady(
  bundle: ModelBundle = DEFAULT_MODEL,
): Promise<boolean> {
  const meta = await loadMeta();
  if (!meta || meta.id !== bundle.id || meta.version !== bundle.version) return false;
  const [a, b] = await Promise.all([
    FileSystem.getInfoAsync(meta.main_path),
    FileSystem.getInfoAsync(meta.mmproj_path),
  ]);
  return a.exists && !a.isDirectory && b.exists && !b.isDirectory;
}

export type DownloadProgress = {
  /** "main" | "mmproj" */
  asset: "main" | "mmproj";
  totalBytes: number;
  writtenBytes: number;
  percent: number;
};

async function downloadOne(
  asset: ModelAsset,
  dest: string,
  label: "main" | "mmproj",
  onProgress?: (p: DownloadProgress) => void,
): Promise<string> {
  const existing = await FileSystem.getInfoAsync(dest);
  if (existing.exists && !existing.isDirectory) {
    console.log(`[edge/model] ${label} already on disk:`, dest);
    return dest;
  }
  console.log(`[edge/model] ${label} download start:`, asset.url);
  const dl = FileSystem.createDownloadResumable(
    asset.url,
    dest,
    {},
    (progress) => {
      const total = progress.totalBytesExpectedToWrite || 1;
      onProgress?.({
        asset: label,
        totalBytes: total,
        writtenBytes: progress.totalBytesWritten,
        percent: (progress.totalBytesWritten / total) * 100,
      });
    },
  );
  const result = await dl.downloadAsync();
  if (!result) throw new Error(`${label} download failed`);
  console.log(`[edge/model] ${label} done:`, result.uri);
  return result.uri;
}

/**
 * モデルバンドル (本体 + mmproj) をダウンロード。
 * 既に両方揃っていれば no-op。片方だけあれば不足分のみ取得。
 */
export async function downloadModel(
  onProgress?: (p: DownloadProgress) => void,
  bundle: ModelBundle = DEFAULT_MODEL,
): Promise<{ main: string; mmproj: string }> {
  if (await isModelReady(bundle)) {
    const paths = modelPaths(bundle);
    console.log("[edge/model] bundle ready:", paths);
    return paths;
  }
  await ensureDir();
  const paths = modelPaths(bundle);

  const mainPath = await downloadOne(bundle.main, paths.main, "main", onProgress);
  const mmprojPath = await downloadOne(bundle.mmproj, paths.mmproj, "mmproj", onProgress);

  await saveMeta({
    id: bundle.id,
    version: bundle.version,
    main_path: mainPath,
    mmproj_path: mmprojPath,
    downloaded_at: new Date().toISOString(),
  });
  return { main: mainPath, mmproj: mmprojPath };
}

export async function deleteModel(): Promise<void> {
  const meta = await loadMeta();
  if (meta) {
    for (const p of [meta.main_path, meta.mmproj_path]) {
      const info = await FileSystem.getInfoAsync(p);
      if (info.exists) await FileSystem.deleteAsync(p, { idempotent: true });
    }
    await AsyncStorage.removeItem(STORAGE_KEY);
    console.log("[edge/model] deleted");
  }
}
