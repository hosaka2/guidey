import { View, Text } from "@tamagui/core";
import type { TextBlock } from "@/types/blocks";

const BG = {
  normal: "#F0F0F0",
  emphasis: "#E3F2FD",
  warning: "#FFF8E1",
};

const COLOR = {
  normal: "#1A1A1A",
  emphasis: "#1565C0",
  warning: "#F57F17",
};

export function TextBlockView({ block }: { block: TextBlock }) {
  const isUser = block.content.startsWith("💬");
  const bg = isUser ? "#DCF8C6" : (BG[block.style] || BG.normal);
  const color = isUser ? "#1A1A1A" : (COLOR[block.style] || COLOR.normal);

  return (
    <View
      alignSelf={isUser ? "flex-end" : "flex-start"}
      maxWidth="85%"
      backgroundColor={bg}
      borderRadius={16}
      borderBottomLeftRadius={isUser ? 16 : 4}
      borderBottomRightRadius={isUser ? 4 : 16}
      paddingHorizontal={12}
      paddingVertical={8}
    >
      <Text fontSize={13} lineHeight={19} color={color}>
        {block.content}
      </Text>
    </View>
  );
}
