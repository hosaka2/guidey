import { Link, Stack } from "expo-router";
import { StyleSheet } from "react-native";
import { View, Text } from "@tamagui/core";

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Oops!" }} />
      <View style={styles.container}>
        <Text fontSize="$6" fontWeight="700" color="$color">
          This screen does not exist.
        </Text>
        <Link href="/" style={styles.link}>
          <Text fontSize="$4" color="#2F95DC">
            Go to home screen!
          </Text>
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  link: {
    marginTop: 15,
    paddingVertical: 15,
  },
});
