import { useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import { View, Text } from "@tamagui/core";

type Props = {
  onFeedback: (sentiment: "positive" | "neutral" | "negative") => void;
};

export function StepFeedback({ onFeedback }: Props) {
  const [sent, setSent] = useState(false);

  const handle = (sentiment: "positive" | "neutral" | "negative") => {
    setSent(true);
    onFeedback(sentiment);
  };

  if (sent) return null;

  return (
    <View style={styles.container}>
      <Text fontSize="$1" color="#999">どうだった?</Text>
      <Pressable onPress={() => handle("positive")} style={styles.btn}>
        <Text fontSize={12}>😊</Text>
      </Pressable>
      <Pressable onPress={() => handle("neutral")} style={styles.btn}>
        <Text fontSize={12}>😐</Text>
      </Pressable>
      <Pressable onPress={() => handle("negative")} style={styles.btn}>
        <Text fontSize={12}>😞</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
  },
  btn: {
    padding: 4,
    backgroundColor: "rgba(0,0,0,0.05)",
    borderRadius: 10,
  },
});
