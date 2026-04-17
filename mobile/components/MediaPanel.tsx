import { useRef } from "react";
import { ScrollView, StyleSheet, Pressable } from "react-native";
import { View } from "@tamagui/core";
import { Feather } from "@expo/vector-icons";
import type { Block } from "@/lib/types";
import { BlockRenderer } from "./BlockRenderer";

type Props = { blocks: Block[] };

export function MediaPanel({ blocks }: Props) {
  const scrollRef = useRef<ScrollView>(null);

  if (blocks.length === 0) return null;

  const scrollUp = () =>
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  const scrollDown = () =>
    scrollRef.current?.scrollToEnd({ animated: true });

  return (
    <View style={styles.container}>
      {/* 上矢印 */}
      {blocks.length > 1 && (
        <Pressable style={styles.arrow} onPress={scrollUp}>
          <Feather name="chevron-up" size={18} color="#fff" />
        </Pressable>
      )}

      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        style={styles.scroll}
      >
        <BlockRenderer blocks={blocks} />
      </ScrollView>

      {/* 下矢印 */}
      {blocks.length > 1 && (
        <Pressable style={styles.arrow} onPress={scrollDown}>
          <Feather name="chevron-down" size={18} color="#fff" />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
  },
  scroll: {
    flex: 1,
    width: "100%",
  },
  content: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    gap: 6,
  },
  arrow: {
    paddingVertical: 2,
    alignItems: "center",
    opacity: 0.6,
  },
});
