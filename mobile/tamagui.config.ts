import { createTamagui } from "@tamagui/core";
import { config as configBase } from "@tamagui/config/v3";

const config = createTamagui({
  ...configBase,
  themes: {
    ...configBase.themes,
    light: {
      ...configBase.themes.light,
      background: "#F8F9FA",
      color: "#1A1A1A",
    },
  },
});

export type AppConfig = typeof config;

declare module "@tamagui/core" {
  interface TamaguiCustomConfig extends AppConfig {}
}

export default config;
