import { StyleSheet } from "react-native";
import { View } from "@tamagui/core";
import type { Block } from "@/lib/types";
import { BlockRenderer } from "./BlockRenderer";

type Props = { blocks: Block[] };

export function TimerPanel({ blocks }: Props) {
  if (blocks.length === 0) return null;

  return (
    <View style={styles.container}>
      <BlockRenderer blocks={blocks} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "stretch",
    paddingHorizontal: 6,
  },
});
