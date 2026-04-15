import { Image, StyleSheet } from "react-native";
import { View, Text } from "@tamagui/core";
import type { ImageBlock } from "@/types/blocks";

export function ImageBlockView({ block }: { block: ImageBlock }) {
  return (
    <View alignSelf="flex-start" maxWidth="75%">
      <View backgroundColor="#F0F0F0" borderRadius={12} overflow="hidden">
        <Image source={{ uri: block.url }} style={styles.image} resizeMode="cover" />
      </View>
      {block.caption ? (
        <Text fontSize={11} color="#888" marginTop={2} marginLeft={4}>
          {block.caption}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  image: { width: 200, height: 130, borderRadius: 12 },
});
