import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_API_URL } from "@/constants/Config";

const STORAGE_KEY = "guidey_api_url";

type ApiContextType = {
  apiUrl: string;
  setApiUrl: (url: string) => void;
};

const ApiContext = createContext<ApiContextType>({
  apiUrl: DEFAULT_API_URL,
  setApiUrl: () => {},
});

export function ApiProvider({ children }: { children: ReactNode }) {
  const [apiUrl, setApiUrlState] = useState(DEFAULT_API_URL);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored) setApiUrlState(stored);
    });
  }, []);

  const setApiUrl = useCallback((url: string) => {
    setApiUrlState(url);
    AsyncStorage.setItem(STORAGE_KEY, url);
  }, []);

  return (
    <ApiContext.Provider value={{ apiUrl, setApiUrl }}>
      {children}
    </ApiContext.Provider>
  );
}

export function useApiContext() {
  return useContext(ApiContext);
}
