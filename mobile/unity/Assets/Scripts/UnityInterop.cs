using System;
using UnityEngine;

/// <summary>
/// Unity → RN メッセージ送信ユーティリティ。
///
/// local Expo Module `expo-unity-view` (com.guidey.app.unityview.UnityToReactBridge)
/// の static method `emitMessage(String)` を AndroidJavaClass 経由で呼ぶ。
/// RN 側は <c>addUnityMessageListener</c> で受信する。
///
/// Editor / iOS では実送信せず Debug.Log だけ出す。
/// </summary>
public static class UnityInterop
{
    /// <summary>RN 側 unityMessage イベントにメッセージ文字列を送信。</summary>
    public static void SendToRN(string message)
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        try
        {
            using (var jc = new AndroidJavaClass("com.guidey.app.unityview.UnityToReactBridge"))
            {
                jc.CallStatic("emitMessage", message);
            }
        }
        catch (Exception e)
        {
            Debug.LogWarning("[UnityInterop] SendToRN Android failed: " + e.Message);
        }
#else
        Debug.Log("[UnityInterop] (editor) " + message);
#endif
    }
}
