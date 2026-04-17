import { useRef, useEffect } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { View } from "@tamagui/core";
import type { Block } from "@/lib/types";
import { BlockRenderer } from "./BlockRenderer";

type Props = { blocks: Block[] };

export function TextPanel({ blocks }: Props) {
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    // 新しいブロック追加時に下にスクロール
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [blocks.length]);

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        <BlockRenderer blocks={blocks} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 6, paddingVertical: 4 },
});
