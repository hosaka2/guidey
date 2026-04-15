import { useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import { View, Text } from "@tamagui/core";

type Props = {
  onFeedback: (sentiment: "positive" | "negative") => void;
};

export function FeedbackButtons({ onFeedback }: Props) {
  const [sent, setSent] = useState<string | null>(null);

  const handle = (sentiment: "positive" | "negative") => {
    setSent(sentiment);
    onFeedback(sentiment);
  };

  if (sent) return null;

  return (
    <View style={styles.container}>
      <Pressable onPress={() => handle("positive")} style={styles.btn}>
        <Text fontSize={12}>👍</Text>
      </Pressable>
      <Pressable onPress={() => handle("negative")} style={styles.btn}>
        <Text fontSize={12}>👎</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingTop: 2,
  },
  btn: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: "rgba(0,0,0,0.05)",
    borderRadius: 10,
  },
});
