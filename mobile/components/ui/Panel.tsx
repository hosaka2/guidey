import { StyleSheet } from "react-native";
import { View } from "./View";
import { useTheme } from "@/lib/theme";

type PanelProps = React.ComponentProps<typeof View>;

/**
 * 角丸・背景・影付きの共通コンテナ。
 * ui-styling: borderCurve='continuous' で iOS の滑らかな角丸を使う。
 * ブロックや情報カード系の枠はこれで統一。
 */
export function Panel(props: PanelProps) {
  const theme = useTheme();
  return (
    <View
      {...props}
      style={[
        styles.base,
        { borderRadius: theme.panelRadius },
        props.style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    borderCurve: "continuous",
    backgroundColor: "rgba(0,0,0,0.65)",
    overflow: "hidden",
  },
});
