import { Pressable } from "react-native";
import { View, Text } from "@tamagui/core";
import { Feather } from "@expo/vector-icons";
import type { VideoBlock } from "@/lib/types";

export function VideoBlockView({ block }: { block: VideoBlock }) {
  return (
    <Pressable onPress={() => {}}>
      <View
        alignSelf="flex-start"
        width={200}
        backgroundColor="#1A1A1A"
        borderRadius={12}
        padding={10}
        flexDirection="row"
        alignItems="center"
        gap={8}
      >
        <Feather name="play-circle" size={20} color="#fff" />
        <View flex={1}>
          <Text color="#fff" fontSize={12} fontWeight="600">動画を再生</Text>
          {block.start_sec != null && block.end_sec != null ? (
            <Text color="rgba(255,255,255,0.6)" fontSize={10}>
              {Math.round(block.start_sec)}s - {Math.round(block.end_sec)}s
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}
