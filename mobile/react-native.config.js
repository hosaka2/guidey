/**
 * React Native autolinking の明示的設定。
 *
 * Local Expo Module `expo-unity-view` (Zenn 記事参考の自前 Unity ラッパー) は Android 専用。
 * iOS 側は `expo-module.config.json` の platforms から apple を外しているため
 * autolinking からも自動的に除外される。このファイルでの明示除外は不要。
 */
module.exports = {
  dependencies: {},
};
