import { View, Text } from "@tamagui/core";
import { Feather } from "@expo/vector-icons";
import type { AlertBlock } from "@/types/blocks";

const CFG = {
  info: { bg: "#E3F2FD", color: "#1565C0", icon: "info" as const },
  warning: { bg: "#FFF3E0", color: "#E65100", icon: "alert-triangle" as const },
  danger: { bg: "#FFEBEE", color: "#C62828", icon: "alert-octagon" as const },
};

export function AlertBlockView({ block }: { block: AlertBlock }) {
  const c = CFG[block.severity] || CFG.info;
  return (
    <View
      alignSelf="flex-start"
      maxWidth="85%"
      backgroundColor={c.bg}
      borderRadius={16}
      borderBottomLeftRadius={4}
      paddingHorizontal={10}
      paddingVertical={6}
      flexDirection="row"
      alignItems="center"
      gap={6}
    >
      <Feather name={c.icon} size={14} color={c.color} />
      <Text color={c.color} fontSize={13} fontWeight="600" flex={1}>
        {block.message}
      </Text>
    </View>
  );
}
