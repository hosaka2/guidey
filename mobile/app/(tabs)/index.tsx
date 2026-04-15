import { StatusBar, StyleSheet, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { View, Text } from "@tamagui/core";
import { useRouter } from "expo-router";
import { MaterialCommunityIcons, Feather } from "@expo/vector-icons";
import { MODE_LIST } from "@/constants/modes";

export default function HomeScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View flex={1} backgroundColor="$background" paddingHorizontal="$4">
        {/* Header */}
        <View
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          paddingTop="$4"
          paddingBottom="$2"
        >
          <Text fontSize="$9" fontWeight="800" color="$color">
            Guidey
          </Text>
          <Pressable onPress={() => router.push("/settings")}>
            <Feather name="settings" size={24} color="#888" />
          </Pressable>
        </View>

        {/* Content */}
        <View flex={1} justifyContent="center" gap="$6">
          <Text
            textAlign="center"
            fontSize="$6"
            color="$color"
            opacity={0.7}
          >
            何をガイドしますか？
          </Text>

          {/* Mode Cards */}
          <View flexDirection="row" gap="$4" justifyContent="center">
            {MODE_LIST.map((mode) => (
              <Pressable
                key={mode.key}
                style={({ pressed }) => [
                  styles.card,
                  pressed && styles.cardPressed,
                ]}
                onPress={() => router.push(`/goal?mode=${mode.key}`)}
                accessibilityRole="button"
              >
                <View alignItems="center" gap="$3">
                  <View
                    width={72}
                    height={72}
                    borderRadius={36}
                    backgroundColor={mode.color + "15"}
                    alignItems="center"
                    justifyContent="center"
                  >
                    <MaterialCommunityIcons
                      name={mode.icon}
                      size={36}
                      color={mode.color}
                    />
                  </View>
                  <Text fontSize="$6" fontWeight="700" color="$color">
                    {mode.label}
                  </Text>
                  <Text fontSize="$2" color="$color" opacity={0.5}>
                    {mode.description}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#F8F9FA",
  },
  card: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 20,
    paddingVertical: 28,
    paddingHorizontal: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
    borderWidth: 1,
    borderColor: "#f0f0f0",
  },
  cardPressed: {
    transform: [{ scale: 0.96 }],
    opacity: 0.85,
  },
});
