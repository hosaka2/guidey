import { useEffect, useRef, useState } from "react";
import { View, Text } from "@tamagui/core";
import { Feather } from "@expo/vector-icons";
import type { TimerBlock } from "@/lib/types";

export function TimerBlockView({ block }: { block: TimerBlock }) {
  const [remaining, setRemaining] = useState(block.duration_sec);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [block.duration_sec]);

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const done = remaining <= 0;

  return (
    <View
      alignSelf="flex-start"
      maxWidth="70%"
      backgroundColor={done ? "#E8F5E9" : "#E3F2FD"}
      borderRadius={16}
      borderBottomLeftRadius={4}
      paddingHorizontal={10}
      paddingVertical={6}
      flexDirection="row"
      alignItems="center"
      gap={6}
    >
      <Feather name={done ? "check-circle" : "clock"} size={14} color={done ? "#2E7D32" : "#1565C0"} />
      <Text fontSize={12} color="#666">{block.label}</Text>
      <Text fontSize={16} fontWeight="700" color={done ? "#2E7D32" : "#1565C0"}>
        {done ? "✓" : `${mins}:${secs.toString().padStart(2, "0")}`}
      </Text>
    </View>
  );
}
