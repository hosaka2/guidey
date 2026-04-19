import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_URL } from "@/constants/Config";
import type { EdgeMode } from "@/lib/edge-llm";
import type { ThemeVariant } from "@/lib/theme";

export type CameraSource = "phone-back" | "xreal-eye";

const STORAGE_KEY_EDGE_MODE = "guidey_edge_mode";
const STORAGE_KEY_LAYOUT = "guidey_layout_variant";
const STORAGE_KEY_CAMERA = "guidey_camera_source";

const DEFAULT_EDGE_MODE: EdgeMode = "cloud";
const DEFAULT_LAYOUT: ThemeVariant = "phone-landscape";
const DEFAULT_CAMERA: CameraSource = "phone-back";

function isLayoutVariant(v: unknown): v is ThemeVariant {
  return v === "phone-landscape" || v === "phone-vr" || v === "smart-glasses";
}
function isEdgeMode(v: unknown): v is EdgeMode {
  return v === "cloud" || v === "gemma-local";
}
function isCameraSource(v: unknown): v is CameraSource {
  return v === "phone-back" || v === "xreal-eye";
}

type ApiContextType = {
  /** ビルド時に決まる BE エンドポイント。Settings では変更不可。 */
  apiUrl: string;
  edgeMode: EdgeMode;
  setEdgeMode: (mode: EdgeMode) => void;
  layoutVariant: ThemeVariant;
  setLayoutVariant: (v: ThemeVariant) => void;
  cameraSource: CameraSource;
  setCameraSource: (s: CameraSource) => void;
};

const ApiContext = createContext<ApiContextType>({
  apiUrl: API_URL,
  edgeMode: DEFAULT_EDGE_MODE,
  setEdgeMode: () => {},
  layoutVariant: DEFAULT_LAYOUT,
  setLayoutVariant: () => {},
  cameraSource: DEFAULT_CAMERA,
  setCameraSource: () => {},
});

export function ApiProvider({ children }: { children: ReactNode }) {
  const [edgeMode, setEdgeModeState] = useState<EdgeMode>(DEFAULT_EDGE_MODE);
  const [layoutVariant, setLayoutVariantState] = useState<ThemeVariant>(DEFAULT_LAYOUT);
  const [cameraSource, setCameraSourceState] = useState<CameraSource>(DEFAULT_CAMERA);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY_EDGE_MODE).then((stored) => {
      if (isEdgeMode(stored)) setEdgeModeState(stored);
    });
    AsyncStorage.getItem(STORAGE_KEY_LAYOUT).then((stored) => {
      if (isLayoutVariant(stored)) setLayoutVariantState(stored);
    });
    AsyncStorage.getItem(STORAGE_KEY_CAMERA).then((stored) => {
      if (isCameraSource(stored)) setCameraSourceState(stored);
    });
  }, []);

  const setEdgeMode = useCallback((mode: EdgeMode) => {
    setEdgeModeState(mode);
    AsyncStorage.setItem(STORAGE_KEY_EDGE_MODE, mode);
    console.log("[edge] mode switched →", mode);
  }, []);

  const setLayoutVariant = useCallback((v: ThemeVariant) => {
    setLayoutVariantState(v);
    AsyncStorage.setItem(STORAGE_KEY_LAYOUT, v);
    console.log("[layout] variant switched →", v);
  }, []);

  const setCameraSource = useCallback((s: CameraSource) => {
    setCameraSourceState(s);
    AsyncStorage.setItem(STORAGE_KEY_CAMERA, s);
    console.log("[camera] source switched →", s);
  }, []);

  return (
    <ApiContext.Provider
      value={{
        apiUrl: API_URL,
        edgeMode, setEdgeMode,
        layoutVariant, setLayoutVariant,
        cameraSource, setCameraSource,
      }}
    >
      {children}
    </ApiContext.Provider>
  );
}

export function useApiContext() {
  return useContext(ApiContext);
}
