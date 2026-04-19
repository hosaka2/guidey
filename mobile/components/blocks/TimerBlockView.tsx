import { useEffect, useRef, useState } from "react";
import { Pressable } from "react-native";
import { View, Text } from "@tamagui/core";
import { Feather } from "@expo/vector-icons";
import type { TimerBlock } from "@/lib/types";

/**
 * システム通知スタイルの Timer 表示 (左上ゾーン用)。
 * チャットバブルとは別の UI: 黒パネル + 明るいアクセント + 閉じるボタン。
 */
export function TimerBlockView({ block }: { block: TimerBlock }) {
  const [remaining, setRemaining] = useState(block.duration_sec);
  const [dismissed, setDismissed] = useState(false);
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

  if (dismissed) return null;

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const done = remaining <= 0;
  const accent = done ? "#4ADE80" : "#60A5FA";

  return (
    <View
      alignSelf="stretch"
      backgroundColor="rgba(15,15,15,0.88)"
      borderRadius={10}
      paddingHorizontal={10}
      paddingVertical={6}
      flexDirection="row"
      alignItems="center"
      gap={8}
      borderWidth={1}
      borderColor="rgba(255,255,255,0.08)"
    >
      <Feather name={done ? "check-circle" : "clock"} size={14} color={accent} />
      <View flex={1}>
        <Text
          fontSize={9}
          color="rgba(255,255,255,0.5)"
          letterSpacing={1}
          textTransform="uppercase"
        >
          {block.label || "Timer"}
        </Text>
        <Text fontSize={16} fontWeight="700" color="#fff">
          {done ? "完了" : `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`}
        </Text>
      </View>
      <Pressable onPress={() => setDismissed(true)} hitSlop={10}>
        <Feather name="x" size={16} color="rgba(255,255,255,0.55)" />
      </Pressable>
    </View>
  );
}
